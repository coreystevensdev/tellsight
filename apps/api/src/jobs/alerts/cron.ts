import { logger } from '../../lib/logger.js';
import { getOrchestratorQueue, JOB_ORCHESTRATOR } from './queue.js';

const CRON_PATTERN = '0 6 * * *';
const SCHEDULER_ID = 'alerts-orchestrator';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the daily orchestrator cron. Idempotent via the scheduler id,
 * same as digest's cron registration, safe to call on every boot.
 */
export async function initAlertsCronJob(): Promise<void> {
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

  logger.info({ pattern: CRON_PATTERN, key: SCHEDULER_ID }, 'Registered alerts cron');
}

export async function shutdownAlertsCron(): Promise<void> {
  const queue = getOrchestratorQueue();
  const removed = await queue.removeJobScheduler(SCHEDULER_ID);
  logger.info({ removed }, 'Removed alerts cron');
}
