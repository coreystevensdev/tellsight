import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';

import { ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../../../lib/logger.js';
import { trackEventOrg } from '../../../services/analytics/trackEvent.js';
import { dbAdmin } from '../../../lib/db.js';
import { digestEligibilityQueries, orgsQueries } from '../../../db/queries/index.js';
import { runCurationPipeline } from '../../../services/curation/index.js';
import { classifyValence } from '../valence.js';
import { generateSubjectLine } from '../subjectLine.js';
import { loadDigestAgentFindings } from '../loadDigestAgentFindings.js';
import { resolveDigestSummary } from '../resolveDigestSummary.js';
import { enqueueDigestSends, persistDigestDelivery } from '../delivery.js';
import { prepareDigestContext } from '../prepareDigestContext.js';
import { orgJobDataSchema } from '../queue.js';

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
        correlationId:
          typeof job.data?.correlationId === 'string' ? job.data.correlationId : undefined,
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
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'no_active_dataset',
      weekStart: weekStart.toISOString(),
    });
    return;
  }

  const org = await orgsQueries.findOrgById(orgId);
  if (!org) {
    logger.warn(
      { correlationId, orgId, jobId: job.id, outcome: 'skipped', durationMs: Date.now() - start },
      'Per-org digest skipped: org row missing (deleted between orchestrator + processing)',
    );
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'org_missing',
      weekStart: weekStart.toISOString(),
    });
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
      {
        correlationId,
        orgId,
        datasetId,
        weekStart,
        jobId: job.id,
        outcome: 'skipped',
        durationMs: Date.now() - start,
      },
      'Per-org digest skipped: no computable stats for this week',
    );
    trackEventOrg(orgId, ANALYTICS_EVENTS.DIGEST_SKIPPED, {
      reason: 'no_computable_stats',
      datasetId,
      weekStart: weekStart.toISOString(),
    });
    return;
  }

  const preparedContext = await prepareDigestContext({
    orgId,
    datasetId,
    weekStart,
    currentStats,
    monthlyFixedCosts: financials?.monthlyFixedCosts,
    correlationId,
  });

  if (preparedContext.noNewData) {
    logger.info(
      {
        correlationId,
        orgId,
        datasetId,
        weekStart,
        jobId: job.id,
        outcome: 'skipped',
        datasetCreatedAt: preparedContext.noNewData.datasetCreatedAt.toISOString(),
        priorDigestWeekStart: preparedContext.noNewData.priorDigestWeekStart.toISOString(),
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

  const {
    firstTimeMilestones,
    transitionMilestones: dedupedTransitionMilestones,
    priorContext,
    promptVersion,
  } = preparedContext;

  const { summaryId, cacheHit, insightCount, content, generatedPromptVersion } =
    await resolveDigestSummary({
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
  const subjectLine = generateSubjectLine(
    valence,
    firstTimeMilestones,
    dedupedTransitionMilestones,
    org.name,
  );

  const { bullets: agentBullets, notifiedProposalIds } = await loadDigestAgentFindings(
    orgId,
    weekStart,
    correlationId,
  );

  const recipients = await digestEligibilityQueries.findOrgRecipients(orgId);
  const { enqueued, enqueueFailures } = await enqueueDigestSends({
    recipients,
    orgId,
    summaryId,
    weekStart,
    orgName: org.name,
    subjectLine,
    agentBullets,
    correlationId,
  });

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
  await persistDigestDelivery({
    orgId,
    datasetId,
    summaryId,
    weekStart,
    subjectLine,
    stateSentence,
    valence,
    currentStats,
    firstTimeMilestones,
    transitionMilestones: dedupedTransitionMilestones,
    notifiedProposalIds,
    enqueued,
    correlationId,
  });

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
