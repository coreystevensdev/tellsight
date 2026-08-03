import { logger } from '../../lib/logger.js';
import { getOrchestratorQueue, JOB_ORCHESTRATOR, CRON_BOOTSTRAP_CORRELATION_ID } from './queue.js';

// 3am, ahead of alerts (6am) and clear of the weekly digest (Sunday 6pm), so
// the three nightly/weekly schedulers never contend for the same orgs' data.
const CRON_PATTERN = '0 3 * * *';
const REPEAT_KEY = 'agent-orchestrator';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the nightly orchestrator cron. Idempotent via BullMQ's
 * repeat.key, safe to call on every boot.
 */
export async function initAgentOrchestratorCronJob(): Promise<void> {
  const queue = getOrchestratorQueue();

  await queue.add(
    JOB_ORCHESTRATOR,
    { correlationId: CRON_BOOTSTRAP_CORRELATION_ID },
    {
      repeat: { pattern: CRON_PATTERN, key: REPEAT_KEY },
      jobId: REPEAT_KEY,
      attempts: ATTEMPTS,
      backoff: { type: 'exponential', delay: BACKOFF_MS },
      removeOnComplete: { count: 50 },
      removeOnFail: { age: 30 * 86_400 },
    },
  );

  logger.info({ pattern: CRON_PATTERN, key: REPEAT_KEY }, 'Registered agent orchestrator cron');
}

export async function shutdownAgentOrchestratorCron(): Promise<void> {
  const queue = getOrchestratorQueue();
  const removed = await queue.removeJobScheduler(REPEAT_KEY);
  logger.info({ removed }, 'Removed agent orchestrator cron');
}
