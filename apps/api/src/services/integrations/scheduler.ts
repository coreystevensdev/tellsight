import { logger } from '../../lib/logger.js';
import { integrationConnectionsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { getSyncQueue } from './worker.js';

const DAILY_CRON = '0 3 * * *'; // 3am UTC every day

function jobIdFor(orgId: number): string {
  return `qb-daily-${orgId}`;
}

export async function registerDailySync(
  orgId: number,
  connectionId: number,
): Promise<void> {
  const queue = getSyncQueue();
  const jobId = jobIdFor(orgId);

  await queue.add(
    jobId,
    { connectionId, trigger: 'scheduled' },
    {
      repeat: { pattern: DAILY_CRON, key: jobId },
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400, count: 100 },
      removeOnFail: { age: 7 * 86_400 },
    },
  );

  logger.info({ orgId, connectionId, pattern: DAILY_CRON }, 'Registered daily QB sync');
}

export async function removeDailySync(orgId: number): Promise<void> {
  const queue = getSyncQueue();
  const jobId = jobIdFor(orgId);

  const removed = await queue.removeJobScheduler(jobId);
  logger.info({ orgId, removed }, 'Removed daily QB sync');
}

/**
 * On API startup: load all QB connections and register their daily syncs.
 * BullMQ's `jobId` on repeatable jobs makes this idempotent, if a job
 * scheduler already exists for a given org, this is a no-op.
 */
export async function initScheduler(): Promise<void> {
  try {
    const connections = await integrationConnectionsQueries.getAllByProvider('quickbooks', dbAdmin);

    for (const connection of connections) {
      await registerDailySync(connection.orgId, connection.id);
    }

    logger.info({ count: connections.length }, 'QB scheduler initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize QB scheduler');
  }
}
