import type { Queue } from 'bullmq';

import { integrationConnectionsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30_000;

interface IntegrationSyncSchedulerConfig {
  provider: string;
  label: string;
  jobPrefix: string;
  dailyCron: string;
  getSyncQueue: () => Queue;
}

/**
 * Builds one provider's daily scheduler operations. Provider modules retain
 * their public functions while the BullMQ template and boot registration loop
 * stay identical across connectors.
 */
export function createIntegrationSyncScheduler(config: IntegrationSyncSchedulerConfig) {
  const jobIdFor = (orgId: number) => `${config.jobPrefix}-daily-${orgId}`;

  async function registerDailySync(orgId: number, connectionId: number): Promise<void> {
    const queue = config.getSyncQueue();
    const jobId = jobIdFor(orgId);

    await queue.upsertJobScheduler(
      jobId,
      { pattern: config.dailyCron },
      {
        name: jobId,
        data: { connectionId, trigger: 'scheduled' },
        opts: {
          attempts: MAX_ATTEMPTS,
          backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
          removeOnComplete: { age: 86_400, count: 100 },
          removeOnFail: { age: 7 * 86_400 },
        },
      },
    );

    logger.info(
      { orgId, connectionId, pattern: config.dailyCron },
      `Registered daily ${config.label} sync`,
    );
  }

  async function removeDailySync(orgId: number): Promise<void> {
    const removed = await config.getSyncQueue().removeJobScheduler(jobIdFor(orgId));
    logger.info({ orgId, removed }, `Removed daily ${config.label} sync`);
  }

  async function initScheduler(): Promise<void> {
    try {
      const connections = await integrationConnectionsQueries.getAllByProvider(
        config.provider,
        dbAdmin,
      );

      for (const connection of connections) {
        await registerDailySync(connection.orgId, connection.id);
      }

      logger.info({ count: connections.length }, `${config.label} scheduler initialized`);
    } catch (error) {
      logger.error({ err: error }, `Failed to initialize ${config.label} scheduler`);
    }
  }

  return { registerDailySync, removeDailySync, initScheduler };
}
