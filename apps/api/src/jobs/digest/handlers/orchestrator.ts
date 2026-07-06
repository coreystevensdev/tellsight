import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';

import { logger } from '../../../lib/logger.js';
import { digestEligibilityQueries } from '../../../db/queries/index.js';
import {
  getOrgQueue,
  JOB_PREFIX_ORG,
  type OrgJobData,
} from '../queue.js';

const PAGE_SIZE = 500;
const ORG_JOB_ATTEMPTS = 3;
const ORG_JOB_BACKOFF_MS = 30_000;

/**
 * Reduces `now` to the most recent Sunday 00:00 UTC. Cron fires at Sunday
 * 18:00 UTC, so the result is the same day's midnight; the digest reports
 * on the just-beginning week with content reflecting through the cron-tick
 * moment. Operationally a Mon-Sun report mailed Sunday evening.
 */
export function currentUtcWeek(now: Date = new Date()): { weekStart: Date; weekEnd: Date } {
  const dayOfWeek = now.getUTCDay();
  const weekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOfWeek, 0, 0, 0, 0),
  );
  const weekEnd = new Date(weekStart.getTime() + 7 * 86_400_000 - 1);
  return { weekStart, weekEnd };
}

function orgJobName(orgId: number, weekStart: Date): string {
  return `${JOB_PREFIX_ORG}-${orgId}-${weekStart.getTime()}`;
}

/**
 * Enumerates eligible orgs and fans out per-org jobs. Per-org failures during
 * enqueue (rare: Redis blip) are logged with orgId and skipped; a partial batch
 * is better than zero batch. DB errors during eligibility lookup propagate and
 * trigger BullMQ retry on the orchestrator job itself.
 */
export async function handleOrchestratorJob(job: Job): Promise<void> {
  const correlationId = randomUUID();
  const { weekStart, weekEnd } = currentUtcWeek();
  const start = Date.now();

  logger.info(
    { correlationId, weekStart, weekEnd, jobId: job.id },
    'Digest orchestrator started',
  );

  const queue = getOrgQueue();
  let cursor: number | undefined;
  let eligibleOrgCount = 0;
  let enqueueFailures = 0;

  for (;;) {
    const orgs = await digestEligibilityQueries.findEligibleOrgs(cursor, PAGE_SIZE);
    if (orgs.length === 0) break;

    for (const org of orgs) {
      const data: OrgJobData = {
        orgId: org.id,
        weekStart,
        weekEnd,
        correlationId,
      };

      try {
        await queue.add(orgJobName(org.id, weekStart), data, {
          attempts: ORG_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: ORG_JOB_BACKOFF_MS },
          removeOnComplete: { count: 50 },
          removeOnFail: { age: 30 * 86_400 },
        });
        eligibleOrgCount++;
      } catch (err) {
        enqueueFailures++;
        logger.error(
          { correlationId, orgId: org.id, err },
          'Failed to enqueue digest-org job, continuing batch',
        );
      }
    }

    if (orgs.length < PAGE_SIZE) break;
    cursor = orgs[orgs.length - 1]!.id;
  }

  logger.info(
    {
      correlationId,
      eligibleOrgCount,
      enqueueFailures,
      weekStart,
      weekEnd,
      durationMs: Date.now() - start,
    },
    'Digest orchestrator complete',
  );
}
