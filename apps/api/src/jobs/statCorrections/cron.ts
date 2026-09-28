import { logger } from '../../lib/logger.js';
import { getExpireQueue, JOB_EXPIRE } from './queue.js';

// Daily at 03:00 UTC, off-peak and ahead of the 06:00 alerts cron and the
// Sunday 18:00 digest cron, so a correction that expired overnight is gone
// from scoreInsights before either of those pipelines run.
const CRON_PATTERN = '0 3 * * *';
const SCHEDULER_ID = 'stat-corrections-expire';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the daily expiry-sweep cron. Idempotent via the scheduler id,
 * same pattern as the alerts and digest cron registrations. Safe to call on
 * every boot.
 */
export async function initStatCorrectionsCronJob(): Promise<void> {
  const queue = getExpireQueue();

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    {
      name: JOB_EXPIRE,
      data: {},
      opts: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: BACKOFF_MS },
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      },
    },
  );

  logger.info({ pattern: CRON_PATTERN, key: SCHEDULER_ID }, 'Registered stat corrections expiry cron');
}

export async function shutdownStatCorrectionsCron(): Promise<void> {
  const queue = getExpireQueue();
  const removed = await queue.removeJobScheduler(SCHEDULER_ID);
  logger.info({ removed }, 'Removed stat corrections expiry cron');
}
