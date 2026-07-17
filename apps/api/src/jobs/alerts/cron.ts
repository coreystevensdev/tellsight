import { logger } from '../../lib/logger.js';
import { getOrchestratorQueue, JOB_ORCHESTRATOR } from './queue.js';

const CRON_PATTERN = '0 6 * * *';
const REPEAT_KEY = 'alerts-orchestrator';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the daily orchestrator cron. Idempotent via BullMQ's repeat.key,
 * same as digest's cron registration, safe to call on every boot.
 */
export async function initAlertsCronJob(): Promise<void> {
  const queue = getOrchestratorQueue();

  await queue.add(
    JOB_ORCHESTRATOR,
    { correlationId: 'cron-bootstrap' },
    {
      repeat: { pattern: CRON_PATTERN, key: REPEAT_KEY },
      jobId: REPEAT_KEY,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { age: 30 * 86_400 },
    },
  );

  logger.info({ pattern: CRON_PATTERN, key: REPEAT_KEY }, 'Registered alerts cron');
}

export async function shutdownAlertsCron(): Promise<void> {
  const queue = getOrchestratorQueue();
  const removed = await queue.removeJobScheduler(REPEAT_KEY);
  logger.info({ removed }, 'Removed alerts cron');
}
