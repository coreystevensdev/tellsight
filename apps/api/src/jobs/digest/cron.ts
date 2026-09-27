import { logger } from '../../lib/logger.js';
import {
  getOrchestratorQueue,
  JOB_ORCHESTRATOR,
} from './queue.js';

// Sunday 18:00 UTC. weekStart resolves to the same day's midnight, so the
// digest reports on the just-beginning week with content reflecting through
// the cron-tick moment. Operationally a Mon-Sun report mailed Sunday evening.
const CRON_PATTERN = '0 18 * * 0';
const SCHEDULER_ID = 'digest-orchestrator';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the weekly orchestrator cron. Idempotent: the scheduler id dedupes
 * a second registration in the same process or across a pod restart mid-tick.
 * Safe to call on every boot.
 */
export async function initDigestCronJob(): Promise<void> {
  const queue = getOrchestratorQueue();

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    {
      name: JOB_ORCHESTRATOR,
      data: { correlationId: 'cron-bootstrap' },
      opts: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: BACKOFF_MS },
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      },
    },
  );

  logger.info({ pattern: CRON_PATTERN, key: SCHEDULER_ID }, 'Registered digest cron');
}

/** Removes the schedule. Useful for graceful shutdown or rotation. */
export async function shutdownDigestCron(): Promise<void> {
  const queue = getOrchestratorQueue();
  const removed = await queue.removeJobScheduler(SCHEDULER_ID);
  logger.info({ removed }, 'Removed digest cron');
}
