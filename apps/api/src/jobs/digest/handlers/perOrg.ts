import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import {
  aiSummariesQueries,
  agentProposalsQueries,
  dataRowsQueries,
  digestEligibilityQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
  orgsQueries,
  subscriptionsQueries,
} from '../../../db/queries/index.js';
import {
  runCurationPipeline,
  assemblePrompt,
  validateStatRefs,
  stripInvalidStatRefs,
  validateCiteRefs,
  stripInvalidCiteRefs,
  transparencyMetadataSchema,
} from '../../../services/curation/index.js';
import { generateInterpretation } from '../../../services/aiInterpretation/claudeClient.js';
import type { ComputedStat } from '../../../services/curation/types.js';
import { classifyValence } from '../valence.js';
import { buildPriorContext, type PriorContextEntry } from '../buildPriorContext.js';
import { detectTransitionMilestones, type TransitionMilestone } from '../milestones.js';
import { detectFirstTimeMilestones } from '../firstTimeMilestones.js';
import { composePriorContext } from '../composePriorContext.js';
import { generateSubjectLine } from '../subjectLine.js';
import {
  getSendQueue,
  JOB_PREFIX_SEND,
  orgJobDataSchema,
  type SendJobData,
} from '../queue.js';

const DIGEST_AUDIENCE = 'digest-weekly' as const;

const SEND_JOB_ATTEMPTS = 3;
const SEND_JOB_BACKOFF_MS = 30_000;

// Per-group cap on agent findings folded into one digest, so a multi-week
// outage can't turn a single email into a wall of bullets.
const AGENT_PROPOSAL_FOLD_IN_CAP = 5;

function sendJobName(userId: number, weekStart: Date): string {
  return `${JOB_PREFIX_SEND}-${userId}-${weekStart.getTime()}`;
}

// First non-blank line of the digest content, stripped of its bullet marker,
// becomes next week's "Last week: ..." lead-in via composePriorContext.
function extractStateSentence(content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine.trim().replace(/^-\s*/, '');
}

/**
 * Per-org handler. Curation always runs, so this week's `ComputedStat[]` is
 * available for valence, longitudinal deltas, and milestone detection even on
 * a cache hit. Cache-first only gates the LLM call: if a digest summary
 * already exists for this (org, dataset, week), `generateInterpretation` is
 * skipped and the cached content is reused. Either way, fan out per-send jobs
 * for eligible org members, then persist the week's history record.
 */
export async function handlePerOrgJob(job: Job): Promise<void> {
  const parsed = orgJobDataSchema.safeParse(job.data);
  if (!parsed.success) {
    logger.warn(
      {
        correlationId: typeof job.data?.correlationId === 'string' ? job.data.correlationId : undefined,
        jobId: job.id,
        issues: parsed.error.issues,
      },
      'invalid job payload, skipping',
    );
    return;
  }

  const { orgId, weekStart, weekEnd, correlationId } = parsed.data;
  const start = Date.now();

  const datasetId = await orgsQueries.getActiveDatasetId(orgId);
  if (datasetId === null) {
    logger.warn(
      { correlationId, orgId, jobId: job.id, outcome: 'skipped', durationMs: Date.now() - start },
      'Per-org digest skipped: org has no active dataset (lost between orchestrator + processing)',
    );
    return;
  }

  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    logger.warn(
      { correlationId, orgId, jobId: job.id, outcome: 'skipped', durationMs: Date.now() - start },
      'Per-org digest skipped: org row missing (deleted between orchestrator + processing)',
    );
    return;
  }

  logger.info(
    { correlationId, orgId, datasetId, weekStart, jobId: job.id },
    'Per-org digest started',
  );

  const businessProfile = (org.businessProfile ?? null) as BusinessProfile | null;
  const financials = businessProfile
    ? {
        cashOnHand: businessProfile.cashOnHand,
        cashAsOfDate: businessProfile.cashAsOfDate,
        businessStartedDate: businessProfile.businessStartedDate,
        monthlyFixedCosts: businessProfile.monthlyFixedCosts,
      }
    : null;

  const insights = await runCurationPipeline(orgId, datasetId, undefined, financials);
  const currentStats = insights.map((i) => i.stat);

  const lastDigest = await digestHistoryQueries.getLastDigest(orgId, weekStart);

  // keyStats is cast, not validated, at the query-helper layer, so a
  // shape-mismatched row throws inside these two calls; caught here so it
  // degrades to "no prior digest" instead of failing before sends go out.
  let priorStats: ComputedStat[] = [];
  let deltaEntries: PriorContextEntry[] = [];
  let transitionMilestones: TransitionMilestone[] = [];
  try {
    priorStats = lastDigest?.keyStats ?? [];
    deltaEntries = buildPriorContext(currentStats, priorStats);
    transitionMilestones = detectTransitionMilestones(currentStats, priorStats);
  } catch (err) {
    logger.error(
      { correlationId, orgId, weekStart, err },
      'Failed to derive prior-digest context, continuing with no prior context',
    );
  }

  // Full monthly history (never digest_history, which only covers recent
  // weeks) and the org's fire-once ledger, explicit dbAdmin since this
  // worker runs with no per-request RLS session.
  const monthlyBuckets = await dataRowsQueries.getMonthlyBucketsByDataset(orgId, datasetId, dbAdmin);
  const awardedKinds = await milestoneAwardsQueries.getAwardedKinds(orgId);
  const firstTimeMilestones = detectFirstTimeMilestones(
    monthlyBuckets,
    financials?.monthlyFixedCosts,
    new Date(),
    awardedKinds,
  );

  // first_break_even is the all-time-first version of crossed_break_even;
  // when both fire the same week, drop the transition one so the body and
  // subject never narrate the same crossing twice.
  const firedFirstBreakEven = firstTimeMilestones.some((m) => m.kind === 'first_break_even');
  const dedupedTransitionMilestones: TransitionMilestone[] = firedFirstBreakEven
    ? transitionMilestones.filter((m) => m.kind !== 'crossed_break_even')
    : transitionMilestones;

  const milestones = [...firstTimeMilestones, ...dedupedTransitionMilestones];
  const priorContext = composePriorContext(lastDigest?.stateSentence, deltaEntries, milestones);
  const promptVersion = priorContext.length > 0 ? 'v2-digest' : 'v1-digest';

  // dbAdmin, like the other platform-level reads in this handler. ai_summaries
  // has RLS and this job runs off a cron with no request and no
  // app.current_org_id, so the default client silently matches nothing here and
  // fails outright on the insert below.
  const cached = await aiSummariesQueries.getCachedDigest(orgId, datasetId, weekStart, dbAdmin);
  let summaryId: number;
  let cacheHit: boolean;
  let insightCount: number;
  let content: string;
  let generatedPromptVersion: string;

  if (cached) {
    summaryId = cached.id;
    cacheHit = true;
    content = cached.content;
    const meta = cached.transparencyMetadata as { statTypes?: unknown[]; promptVersion?: string } | null;
    insightCount = Array.isArray(meta?.statTypes) ? meta!.statTypes!.length : 0;
    // The cached summary may have been generated under an earlier promptVersion
    // than what this run's fresh diff would pick, so log what actually produced
    // the content being sent, not what would be selected generating fresh now.
    generatedPromptVersion = meta?.promptVersion ?? promptVersion;
  } else {
    insightCount = insights.length;

    const { system, user, metadata } = assemblePrompt(
      insights,
      datasetId,
      promptVersion,
      businessProfile,
      new Date(),
      priorContext,
    );
    const validatedMetadata = transparencyMetadataSchema.parse(metadata);

    const generated = await generateInterpretation({ system, user });
    const refReport = validateStatRefs(generated, insights.map((i) => i.stat));
    const chartRefsStripped =
      refReport.invalidRefs.length > 0
        ? stripInvalidStatRefs(generated, refReport.invalidRefs)
        : generated;

    // Tier 2b, same defense-in-depth as index.ts/streamHandler.ts: v1-digest
    // and v2-digest never ask the LLM for a <cite> tag, but formatStat
    // appends the [cite: <id>] suffix to every stat line regardless of which
    // template renders it, so a hallucinated citation is still possible here.
    const citeReport = validateCiteRefs(chartRefsStripped, insights.map((i) => i.stat), datasetId);
    const cleaned =
      citeReport.invalidRefs.length > 0
        ? stripInvalidCiteRefs(chartRefsStripped, citeReport.invalidRefs)
        : chartRefsStripped;
    if (citeReport.invalidRefs.length > 0) {
      logger.warn(
        { orgId, datasetId, invalidRefs: citeReport.invalidRefs, promptVersion },
        'AI summary referenced unknown stat instance IDs, stripped before cache',
      );
    }

    const stored = await aiSummariesQueries.storeSummary({
      orgId,
      datasetId,
      content: cleaned,
      metadata: validatedMetadata,
      promptVersion,
      audience: DIGEST_AUDIENCE,
      weekStart,
      client: dbAdmin,
    });
    summaryId = stored.id;
    cacheHit = false;
    content = cleaned;
    generatedPromptVersion = promptVersion;
  }

  const stateSentence = extractStateSentence(content);
  const valence = classifyValence(currentStats);
  const subjectLine = generateSubjectLine(valence, firstTimeMilestones, dedupedTransitionMilestones, org.name);

  // Auto-notify agent findings accumulated during the week, plus expired
  // findings nobody reviewed, fold into this digest as extra bullets.
  // Fetched once, before the recipient loop, so every recipient's
  // SendJobData carries the identical bullet list -- markNotified below
  // fires once per org, not once per recipient, so a second recipient's send
  // never re-queries and finds nothing left. Each group is capped at
  // AGENT_PROPOSAL_FOLD_IN_CAP so a multi-week outage can't turn one email
  // into an unbounded list; anything past the cap collapses into a single
  // "+N more" note instead of vanishing without a trace. Both groups pass
  // through the same markNotified call, so an expired-and-folded proposal
  // actually leaves 'expired' this time instead of sitting there forever and
  // re-folding into every following retry and digest.
  // Re-verified here, not just at generation time: an org can downgrade out
  // of the Agent tier between when a proposal was generated and this week's
  // digest, and an entitlement gate should never fail open (same posture as
  // evaluateOrg.ts's own re-check).
  // Isolated in its own try/catch: this fold-in is additive to an
  // already-shipped digest send, a transient error here should cost the org
  // its agent bullets for the week, not the whole digest.
  let autoNotifyProposals: Awaited<ReturnType<typeof agentProposalsQueries.getPendingProposals>> = [];
  let expiredProposals: Awaited<ReturnType<typeof agentProposalsQueries.getExpiredUnfoldedProposals>> = [];
  let expiredTotal = 0;
  try {
    const agentEnabled = await subscriptionsQueries.getAgentEnabled(orgId, dbAdmin);
    if (agentEnabled) {
      const pendingProposals = await agentProposalsQueries.getPendingProposals(orgId);
      autoNotifyProposals = pendingProposals.filter((p) => p.lane === 'auto_notify');
      expiredProposals = await agentProposalsQueries.getExpiredUnfoldedProposals(
        orgId,
        weekStart,
        AGENT_PROPOSAL_FOLD_IN_CAP,
      );
      // Conservative fallback if the count query below throws: assume
      // nothing was omitted rather than reporting a number we can't confirm.
      expiredTotal = expiredProposals.length;
      expiredTotal = await agentProposalsQueries.countExpiredUnfoldedProposals(orgId, weekStart);
    }
  } catch (err) {
    logger.error(
      { correlationId, orgId, err },
      'Failed to fetch some agent proposals for the digest, continuing with whatever was already fetched',
    );
  }

  const autoNotifyToFold = autoNotifyProposals.slice(0, AGENT_PROPOSAL_FOLD_IN_CAP);
  const autoNotifyOmitted = Math.max(0, autoNotifyProposals.length - AGENT_PROPOSAL_FOLD_IN_CAP);
  const expiredOmitted = Math.max(0, expiredTotal - expiredProposals.length);
  const omitted = autoNotifyOmitted + expiredOmitted;

  const agentBullets = [
    ...autoNotifyToFold.map((p) => `${p.title}: ${p.recommendation}`),
    ...expiredProposals.map((p) => `${p.title} (expired without review): ${p.recommendation}`),
  ];
  if (omitted > 0) {
    agentBullets.push(`+${omitted} more agent finding${omitted === 1 ? '' : 's'} not shown this week`);
  }

  const recipients = await digestEligibilityQueries.findOrgRecipients(orgId);
  const queue = getSendQueue();

  let enqueued = 0;
  let enqueueFailures = 0;

  for (const r of recipients) {
    const data: SendJobData = {
      userId: r.userId,
      orgId,
      summaryId,
      weekStart,
      userEmail: r.email,
      orgName: org.name,
      subjectLine,
      agentBullets,
      correlationId,
    };

    try {
      // BullMQ dedupes on jobId, not the `name` argument, name alone looked
      // like a dedup key but wasn't; a retried per-org attempt would have
      // re-enqueued every send job again.
      const jobId = sendJobName(r.userId, weekStart);
      await queue.add(jobId, data, {
        jobId,
        attempts: SEND_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: SEND_JOB_BACKOFF_MS },
        removeOnComplete: { count: 100 },
        removeOnFail: { age: 30 * 86_400 },
      });
      enqueued++;
    } catch (err) {
      enqueueFailures++;
      logger.error(
        { correlationId, orgId, userId: r.userId, outcome: 'enqueue_failure', err },
        'Failed to enqueue digest-send job, continuing',
      );
    }
  }

  // Sends are already enqueued by this point, so a write failure here never
  // fails the job. History and awards commit together, an award recorded
  // without its digest_history row (or vice versa) would leave the audit
  // trail out of sync with the fire-once ledger. This week's digest_history
  // row is never recovered on rollback (each week only gets written by that
  // week's own run); a rolled-back award, in contrast, can still fire next
  // week as long as the org stays in the same calendar month, past month-end
  // it's permanently missed, accepted given the (org_id, kind) unique index
  // only guarantees at-most-once, not at-least-once. A rolled-back
  // markNotified has the same accepted risk: the proposals stay `pending`
  // even though their bullets already reached an inbox, so they'd fold into
  // next week's digest too, a duplicate notification rather than a lost one.
  try {
    await dbAdmin.transaction(async (tx) => {
      await digestHistoryQueries.saveDigestHistory(
        {
          orgId,
          datasetId,
          summaryId,
          weekStart,
          subjectLine,
          stateSentence,
          valence,
          keyStats: currentStats,
          milestones: [
            ...firstTimeMilestones.map((m) => ({
              kind: m.kind,
              label: m.label,
              catalog: 'first_time' as const,
            })),
            ...dedupedTransitionMilestones.map((m) => ({
              kind: m.kind,
              label: m.label,
              catalog: 'transition' as const,
            })),
          ],
          sentAt: new Date(),
        },
        tx,
      );

      for (const m of firstTimeMilestones) {
        await milestoneAwardsQueries.awardMilestone({ orgId, kind: m.kind, datasetId }, tx);
      }

      // Only mark proposals notified if a send actually went out -- an empty
      // recipient list or every enqueue failing means nobody actually saw
      // these bullets, and marking them notified anyway would lose the
      // finding for good (it never surfaces again after this). Only the ids
      // actually folded into agentBullets are passed here. Auto_notify ids
      // the cap omitted stay 'pending' and get reconsidered next week
      // (getPendingProposals has no time window); expired ids the cap
      // omitted stay 'expired' but are gone for good once weekStart moves
      // past their resolvedAt -- no backfill, by design (2026-08-02).
      if (enqueued > 0) {
        await agentProposalsQueries.markNotified(
          orgId,
          [...autoNotifyToFold, ...expiredProposals].map((p) => p.id),
          tx,
        );
      }
    });
  } catch (err) {
    logger.error(
      { correlationId, orgId, weekStart, milestoneKinds: firstTimeMilestones.map((m) => m.kind), err },
      'Failed to save digest history and award milestones, continuing',
    );
  }

  logger.info(
    {
      correlationId,
      orgId,
      datasetId,
      summaryId,
      cacheHit,
      insightCount,
      promptVersion: generatedPromptVersion,
      sendJobsEnqueued: enqueued,
      enqueueFailures,
      weekStart,
      weekEnd,
      outcome: 'sent',
      durationMs: Date.now() - start,
    },
    'Per-org digest complete',
  );
}
