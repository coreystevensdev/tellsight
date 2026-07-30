import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { alertEligibilityQueries } from '../../../db/queries/index.js';
import {
  getEvaluateOrgQueue,
  JOB_PREFIX_EVALUATE_ORG,
  orchestratorJobDataSchema,
  type EvaluateOrgJobData,
} from '../queue.js';

const PAGE_SIZE = 500;
const EVALUATE_ORG_ATTEMPTS = 3;
const EVALUATE_ORG_BACKOFF_MS = 30_000;

function evaluateOrgJobName(orgId: number, datasetId: number): string {
  return `${JOB_PREFIX_EVALUATE_ORG}-${orgId}-${datasetId}`;
}

async function enqueueEvaluateOrg(
  orgId: number,
  datasetId: number,
  trigger: EvaluateOrgJobData['trigger'],
  correlationId: string,
): Promise<void> {
  const data: EvaluateOrgJobData = { orgId, datasetId, trigger, correlationId };
  // BullMQ dedupes on jobId, not name; pass the same deterministic string as
  // both so a retried enqueue for the same org/dataset is genuinely deduped.
  const jobId = evaluateOrgJobName(orgId, datasetId);
  await getEvaluateOrgQueue().add(jobId, data, {
    jobId,
    attempts: EVALUATE_ORG_ATTEMPTS,
    backoff: { type: 'exponential', delay: EVALUATE_ORG_BACKOFF_MS },
    removeOnComplete: { count: 50 },
    removeOnFail: { age: 30 * 86_400 },
  });
}

/**
 * Single entry point for both triggers. On-upload jobs carry orgId+datasetId
 * and fan out to exactly one org; cron jobs carry neither and page every
 * eligible org. A payload with only one of the two set is rejected rather
 * than silently treated as a cron job. `evaluateOrg` re-verifies tier and
 * rules itself either way, this handler only decides who gets a job.
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

  const { orgId, datasetId, correlationId: incomingCorrelationId } = parsed.data;
  const correlationId = incomingCorrelationId === 'cron-bootstrap' ? randomUUID() : incomingCorrelationId;
  const start = Date.now();

  // Schema allows orgId/datasetId independently since cron jobs carry neither, but a
  // payload with only one set can't be a valid on-upload or cron job -- likely a tampered
  // or hand-edited job (e.g. a Bull Board retry-with-edit), not one either branch produces.
  if ((orgId !== undefined) !== (datasetId !== undefined)) {
    logger.warn(
      { jobId: job.id, correlationId, orgId, datasetId },
      'malformed job payload: exactly one of orgId/datasetId defined, skipping',
    );
    return;
  }

  if (orgId !== undefined && datasetId !== undefined) {
    await enqueueEvaluateOrg(orgId, datasetId, 'on-upload', correlationId);
    logger.info(
      { correlationId, orgId, datasetId, trigger: 'on-upload', jobId: job.id, durationMs: Date.now() - start },
      'Alerts orchestrator complete (on-upload)',
    );
    return;
  }

  logger.info({ correlationId, jobId: job.id }, 'Alerts orchestrator started (cron)');

  let cursor: number | undefined;
  let eligibleOrgCount = 0;
  let enqueueFailures = 0;

  for (;;) {
    const orgs = await alertEligibilityQueries.findEligibleOrgs(cursor, PAGE_SIZE);
    if (orgs.length === 0) break;

    for (const org of orgs) {
      try {
        await enqueueEvaluateOrg(org.id, org.activeDatasetId, 'cron', correlationId);
        eligibleOrgCount++;
      } catch (err) {
        enqueueFailures++;
        logger.error(
          { correlationId, orgId: org.id, err },
          'Failed to enqueue alerts-evaluate-org job, continuing batch',
        );
      }
    }

    if (orgs.length < PAGE_SIZE) break;
    cursor = orgs[orgs.length - 1]!.id;
  }

  logger.info(
    { correlationId, eligibleOrgCount, enqueueFailures, trigger: 'cron', durationMs: Date.now() - start },
    'Alerts orchestrator complete (cron)',
  );
}
