import { logger } from '../../lib/logger.js';
import { getOrchestratorQueue, JOB_ORCHESTRATOR, CRON_BOOTSTRAP_CORRELATION_ID } from './queue.js';

// 3am, ahead of alerts (6am) and clear of the weekly digest (Sunday 6pm), so
// the three nightly/weekly schedulers never contend for the same orgs' data.
const CRON_PATTERN = '0 3 * * *';
const SCHEDULER_ID = 'agent-orchestrator';

const ATTEMPTS = 3;
const BACKOFF_MS = 60_000;

/**
 * Registers the nightly orchestrator cron. Idempotent via the scheduler id,
 * safe to call on every boot.
 */
export async function initAgentOrchestratorCronJob(): Promise<void> {
  const queue = getOrchestratorQueue();

  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: CRON_PATTERN },
    {
      name: JOB_ORCHESTRATOR,
      data: { correlationId: CRON_BOOTSTRAP_CORRELATION_ID },
      opts: {
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: BACKOFF_MS },
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      },
    },
  );

  logger.info({ pattern: CRON_PATTERN, key: SCHEDULER_ID }, 'Registered agent orchestrator cron');
}

export async function shutdownAgentOrchestratorCron(): Promise<void> {
  const queue = getOrchestratorQueue();
  const removed = await queue.removeJobScheduler(SCHEDULER_ID);
  logger.info({ removed }, 'Removed agent orchestrator cron');
}
