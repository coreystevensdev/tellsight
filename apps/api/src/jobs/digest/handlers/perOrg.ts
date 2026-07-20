import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';

import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import {
  aiSummariesQueries,
  dataRowsQueries,
  digestEligibilityQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
  orgsQueries,
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

  const cached = await aiSummariesQueries.getCachedDigest(orgId, datasetId, weekStart);
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

    const stored = await aiSummariesQueries.storeSummary({
      orgId,
      datasetId,
      content: cleaned,
      metadata: validatedMetadata,
      promptVersion,
      audience: DIGEST_AUDIENCE,
      weekStart,
    });
    summaryId = stored.id;
    cacheHit = false;
    content = cleaned;
    generatedPromptVersion = promptVersion;
  }

  const stateSentence = extractStateSentence(content);
  const valence = classifyValence(currentStats);
  const subjectLine = generateSubjectLine(valence, firstTimeMilestones, dedupedTransitionMilestones, org.name);

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
  // only guarantees at-most-once, not at-least-once.
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
