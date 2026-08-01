import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { agentEligibilityQueries } from '../../../db/queries/index.js';
import {
  getEvaluateOrgQueue,
  JOB_PREFIX_EVALUATE_ORG,
  orchestratorJobDataSchema,
  type EvaluateOrgJobData,
} from '../queue.js';

const PAGE_SIZE = 500;
const EVALUATE_ORG_ATTEMPTS = 3;
const EVALUATE_ORG_BACKOFF_MS = 30_000;

// UTC-dated, unlike alerts' equivalent: alerts' evaluate-org jobId has no
// date component because an on-upload trigger naturally gets a fresh
// datasetId most of the time. This pipeline is cron-only and re-evaluates
// the SAME active dataset every night by design, so a bare orgId+datasetId
// jobId would collide with the still-retained job from the prior run
// (removeOnComplete/removeOnFail keep it around for a count/30 days) and
// BullMQ's dedupe-on-jobId would silently skip every night after the first.
function evaluateOrgJobName(orgId: number, datasetId: number, runDate: string): string {
  return `${JOB_PREFIX_EVALUATE_ORG}-${orgId}-${datasetId}-${runDate}`;
}

async function enqueueEvaluateOrg(
  orgId: number,
  datasetId: number,
  correlationId: string,
  runDate: string,
): Promise<void> {
  const data: EvaluateOrgJobData = { orgId, datasetId, correlationId };
  // BullMQ dedupes on jobId, not name; pass the same deterministic string as
  // both so a retried enqueue for the same org/dataset/night is genuinely
  // deduped, without colliding with a different night's run.
  const jobId = evaluateOrgJobName(orgId, datasetId, runDate);
  await getEvaluateOrgQueue().add(jobId, data, {
    jobId,
    attempts: EVALUATE_ORG_ATTEMPTS,
    backoff: { type: 'exponential', delay: EVALUATE_ORG_BACKOFF_MS },
    removeOnComplete: { count: 50 },
    removeOnFail: { age: 30 * 86_400 },
  });
}

/**
 * Nightly-only entry point (no on-upload trigger for the agent tier).
 * Pages every Agent-tier eligible org and fans out one evaluate-org job per
 * org. `evaluateOrg` re-verifies entitlement itself, this handler only
 * decides who gets a job, same division of responsibility as alerts.
 */
export async function handleOrchestratorJob(job: Job): Promise<void> {
  const parsed = orchestratorJobDataSchema.safeParse(job.data);
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

  const { correlationId: incomingCorrelationId } = parsed.data;
  // Repeatable jobs need static job data, so cron.ts registers this with a
  // placeholder; swap it for a real id here so every log line for this run
  // shares one traceable value, same as alerts' orchestrator.
  const correlationId = incomingCorrelationId === 'cron-bootstrap' ? randomUUID() : incomingCorrelationId;
  const start = Date.now();

  logger.info({ correlationId, jobId: job.id }, 'Agent orchestrator started');

  // One date stamp for the whole run: every org enqueued by this orchestrator
  // invocation shares it, so a retried orchestrator job (same night) still
  // dedupes correctly against jobs it already enqueued.
  const runDate = new Date().toISOString().slice(0, 10);

  let cursor: number | undefined;
  let eligibleOrgCount = 0;
  let enqueueFailures = 0;

  for (;;) {
    const orgs = await agentEligibilityQueries.findEligibleOrgs(cursor, PAGE_SIZE);
    if (orgs.length === 0) break;

    for (const org of orgs) {
      try {
        await enqueueEvaluateOrg(org.id, org.activeDatasetId, correlationId, runDate);
        eligibleOrgCount++;
      } catch (err) {
        enqueueFailures++;
        logger.error(
          { correlationId, orgId: org.id, err },
          'Failed to enqueue agent-evaluate-org job, continuing batch',
        );
      }
    }

    if (orgs.length < PAGE_SIZE) break;
    cursor = orgs[orgs.length - 1]!.id;
  }

  logger.info(
    { correlationId, eligibleOrgCount, enqueueFailures, durationMs: Date.now() - start },
    'Agent orchestrator complete',
  );
}
