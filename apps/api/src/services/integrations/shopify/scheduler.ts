import { logger } from '../../../lib/logger.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { dbAdmin } from '../../../lib/db.js';
import { getSyncQueue } from './worker.js';

const DAILY_CRON = '0 4 * * *'; // 4am UTC, an hour after QuickBooks' 3am to avoid both providers hammering Redis in the same minute

function jobIdFor(orgId: number): string {
  return `shopify-daily-${orgId}`;
}

export async function registerDailySync(orgId: number, connectionId: number): Promise<void> {
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

  logger.info({ orgId, connectionId, pattern: DAILY_CRON }, 'Registered daily Shopify sync');
}

export async function removeDailySync(orgId: number): Promise<void> {
  const queue = getSyncQueue();
  const jobId = jobIdFor(orgId);

  const removed = await queue.removeJobScheduler(jobId);
  logger.info({ orgId, removed }, 'Removed daily Shopify sync');
}

/**
 * On API startup: load all Shopify connections and register their daily
 * syncs. BullMQ's `jobId` on repeatable jobs makes this idempotent.
 */
export async function initScheduler(): Promise<void> {
  try {
    const connections = await integrationConnectionsQueries.getAllByProvider('shopify', dbAdmin);

    for (const connection of connections) {
      await registerDailySync(connection.orgId, connection.id);
    }

    logger.info({ count: connections.length }, 'Shopify scheduler initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Shopify scheduler');
  }
}
