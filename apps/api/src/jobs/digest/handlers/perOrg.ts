import type { Job } from 'bullmq';
import type { BusinessProfile } from 'shared/types';

import { logger } from '../../../lib/logger.js';
import {
  aiSummariesQueries,
  digestEligibilityQueries,
  digestHistoryQueries,
  orgsQueries,
} from '../../../db/queries/index.js';
import {
  runCurationPipeline,
  assemblePrompt,
  validateStatRefs,
  stripInvalidStatRefs,
  transparencyMetadataSchema,
} from '../../../services/curation/index.js';
import { generateInterpretation } from '../../../services/aiInterpretation/claudeClient.js';
import { classifyValence } from '../valence.js';
import { buildPriorContext } from '../buildPriorContext.js';
import { detectTransitionMilestones } from '../milestones.js';
import { composePriorContext } from '../composePriorContext.js';
import {
  getSendQueue,
  JOB_PREFIX_SEND,
  type OrgJobData,
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
  const { orgId, weekStart, weekEnd, correlationId } = job.data as OrgJobData;
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

  const lastDigest = await digestHistoryQueries.getLastDigest(orgId);
  const priorStats = lastDigest?.keyStats ?? [];
  const deltaEntries = buildPriorContext(currentStats, priorStats);
  const milestones = detectTransitionMilestones(currentStats, priorStats);
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
      promptVersion,
      businessProfile,
      new Date(),
      priorContext,
    );
    const validatedMetadata = transparencyMetadataSchema.parse(metadata);

    const generated = await generateInterpretation({ system, user });
    const refReport = validateStatRefs(generated, insights.map((i) => i.stat));
    const cleaned =
      refReport.invalidRefs.length > 0
        ? stripInvalidStatRefs(generated, refReport.invalidRefs)
        : generated;

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
      correlationId,
    };

    try {
      await queue.add(sendJobName(r.userId, weekStart), data, {
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

  // Sends are already enqueued by this point, so a history-write failure never
  // fails the job. Cost: a missed save blanks longitudinal context until the
  // next successful save (buildPriorContext and detectTransitionMilestones
  // both read the most recent digest_history row), not just for next week.
  try {
    await digestHistoryQueries.saveDigestHistory({
      orgId,
      datasetId,
      summaryId,
      weekStart,
      subjectLine: `${org.name} weekly insights`,
      stateSentence,
      valence,
      keyStats: currentStats,
      milestones: milestones.map((m) => ({ kind: m.kind, label: m.label })),
      sentAt: new Date(),
    });
  } catch (err) {
    logger.error({ correlationId, orgId, weekStart, err }, 'Failed to save digest history, continuing');
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
