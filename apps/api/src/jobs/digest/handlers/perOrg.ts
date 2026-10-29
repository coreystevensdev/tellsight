import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';

import { ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../../../lib/logger.js';
import { trackEventOrg } from '../../../services/analytics/trackEvent.js';
import { dbAdmin } from '../../../lib/db.js';
import {
  agentProposalsQueries,
  dataRowsQueries,
  datasetsQueries,
  digestEligibilityQueries,
  digestHistoryQueries,
  milestoneAwardsQueries,
  orgsQueries,
} from '../../../db/queries/index.js';
import { runCurationPipeline } from '../../../services/curation/index.js';
import type { ComputedStat } from '../../../services/curation/types.js';
import { classifyValence } from '../valence.js';
import { buildPriorContext, type PriorContextEntry } from '../buildPriorContext.js';
import { detectTransitionMilestones, type TransitionMilestone } from '../milestones.js';
import { detectFirstTimeMilestones } from '../firstTimeMilestones.js';
import { composePriorContext } from '../composePriorContext.js';
import { generateSubjectLine } from '../subjectLine.js';
import { loadDigestAgentFindings } from '../loadDigestAgentFindings.js';
import { resolveDigestSummary } from '../resolveDigestSummary.js';
import {
  getSendQueue,
  JOB_PREFIX_SEND,
  orgJobDataSchema,
  type SendJobData,
} from '../queue.js';

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
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, { reason: 'no_active_dataset', weekStart: weekStart.toISOString() });
    return;
  }

  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    logger.warn(
      { correlationId, orgId, jobId: job.id, outcome: 'skipped', durationMs: Date.now() - start },
      'Per-org digest skipped: org row missing (deleted between orchestrator + processing)',
    );
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, { reason: 'org_missing', weekStart: weekStart.toISOString() });
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

  // dbAdmin, not the default. runCurationPipeline's client parameter defaults to
  // the RLS-scoped db, which is right inside a request and wrong here: a BullMQ
  // worker has no request, so app.current_org_id is unset and every row is
  // filtered out. getRowsByDataset then returns nothing, the pipeline logs
  // "curation pipeline got 0 rows, dataset may not exist", and the caller below
  // reports "no computable stats for this week" about a dataset that is full.
  //
  // The alerts and agent workers both pass dbAdmin here. This one did not, which
  // is why no digest has ever been sent. Line 165 of this same file already
  // passes dbAdmin explicitly for the monthly buckets.
  const insights = await runCurationPipeline(orgId, datasetId, dbAdmin, financials);
  const currentStats = insights.map((i) => i.stat);

  // Nothing computable means nothing to interpret, and interpretation is the
  // entire premise of this email. Bail before the Claude call rather than
  // paying for a summary whose content is "I don't have any data this week".
  //
  // A dataset that stopped receiving rows is a real signal, but it belongs to
  // the alerts pipeline. Sending it weekly here trains people to ignore the
  // digest, which is the one thing it cannot afford.
  if (insights.length === 0) {
    logger.info(
      { correlationId, orgId, datasetId, weekStart, jobId: job.id, outcome: 'skipped', durationMs: Date.now() - start },
      'Per-org digest skipped: no computable stats for this week',
    );
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, { reason: 'no_computable_stats', datasetId, weekStart: weekStart.toISOString() });
    return;
  }

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

  // A monthly uploader on a weekly digest gets four emails per data change,
  // three of them restating the same numbers. That is the same failure the
  // 30-day staleness gate exists to prevent (FR58), one grain finer, and the
  // gate cannot see it because the data is not stale, it is merely unchanged.
  //
  // The test is whether new data arrived, not whether the tracked stats moved.
  // buildPriorContext compares four stat types out of the pipeline's full set,
  // so an empty deltaEntries means "none of those four moved", not "nothing to
  // say": a new expense category or a shifted forecast would produce no delta
  // and still be worth sending. Datasets are immutable, every ingest path mints
  // a new row, so created_at older than the last digest means nothing has come
  // in since, and nothing computed from it can have changed either.
  //
  // dbAdmin explicitly. getDatasetById defaults to the RLS-scoped client, which
  // in a worker has no app.current_org_id and returns undefined, and undefined
  // here reads as "cannot tell" and sends. Safe, but it would silently disable
  // this skip forever.
  const activeDataset = await datasetsQueries.getDatasetById(orgId, datasetId, dbAdmin);
  const priorWeekStart = lastDigest?.weekStart;
  const noNewDataSincePrior =
    priorWeekStart instanceof Date &&
    activeDataset?.createdAt instanceof Date &&
    activeDataset.createdAt.getTime() <= priorWeekStart.getTime();

  // Milestones are belt and braces. They are derived from the same data, so an
  // unchanged dataset should not produce new ones, and detectFirstTimeMilestones
  // takes the wall clock as an argument. Cheap enough to not have to be sure.
  if (noNewDataSincePrior && deltaEntries.length === 0 && milestones.length === 0) {
    logger.info(
      {
        correlationId, orgId, datasetId, weekStart, jobId: job.id,
        outcome: 'skipped',
        datasetCreatedAt: activeDataset!.createdAt.toISOString(),
        priorDigestWeekStart: priorWeekStart!.toISOString(),
        durationMs: Date.now() - start,
      },
      'Per-org digest skipped: no new data since the last digest',
    );
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'no_new_data_since_prior',
      datasetId,
      weekStart: weekStart.toISOString(),
    });
    return;
  }
  // getLastDigest returns the most recent digest, not the adjacent week, and
  // skipped weeks now make gaps ordinary. Pass the real distance so the lead-in
  // cannot call a three-week-old snapshot "last week".
  const weeksSincePrior = lastDigest?.weekStart
    ? Math.max(1, Math.round((weekStart.getTime() - lastDigest.weekStart.getTime()) / WEEK_MS))
    : 1;
  const priorContext = composePriorContext(
    lastDigest?.stateSentence,
    deltaEntries,
    milestones,
    weeksSincePrior,
  );
  const promptVersion = priorContext.length > 0 ? 'v2-digest' : 'v1-digest';

  const {
    summaryId,
    cacheHit,
    insightCount,
    content,
    generatedPromptVersion,
  } = await resolveDigestSummary({
    orgId,
    datasetId,
    weekStart,
    promptVersion,
    businessProfile,
    priorContext,
    insights,
  });

  const stateSentence = extractStateSentence(content);
  const valence = classifyValence(currentStats);
  const subjectLine = generateSubjectLine(valence, firstTimeMilestones, dedupedTransitionMilestones, org.name);

  const { bullets: agentBullets, notifiedProposalIds } = await loadDigestAgentFindings(
    orgId,
    weekStart,
    correlationId,
  );

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
        await agentProposalsQueries.markNotified(orgId, notifiedProposalIds, tx);
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
