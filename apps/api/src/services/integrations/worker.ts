import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { runSync, type SyncTrigger } from './quickbooks/sync.js';
import { TokenRevokedError } from './quickbooks/errors.js';

export const SYNC_QUEUE_NAME = 'quickbooks-sync';
const WORKER_CONCURRENCY = 2;
const RETRY_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 3;

export interface SyncJobData {
  connectionId: number;
  trigger: SyncTrigger;
}

let queue: Queue | null = null;
let worker: Worker | null = null;

function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    // BullMQ requires maxRetriesPerRequest: null on worker connections
    maxRetriesPerRequest: null,
  };
}

export function getSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(SYNC_QUEUE_NAME, { connection: connectionOptions() });
  }
  return queue;
}

export async function enqueueSyncJob(
  connectionId: number,
  trigger: SyncTrigger,
): Promise<void> {
  const q = getSyncQueue();
  await q.add(
    `qb-${trigger}-${connectionId}`,
    { connectionId, trigger },
    {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
      removeOnComplete: { age: 86_400, count: 1000 },
      removeOnFail: { age: 7 * 86_400 },
    },
  );
  logger.info({ connectionId, trigger }, 'Enqueued QB sync job');
}

export function initSyncWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(
    SYNC_QUEUE_NAME,
    async (job: Job) => {
      const { connectionId, trigger } = job.data as SyncJobData;
      logger.info({ jobId: job.id, connectionId, trigger }, 'Processing QB sync job');

      try {
        const result = await runSync(connectionId, trigger);
        logger.info(
          { jobId: job.id, connectionId, rowsSynced: result.rowsSynced },
          'QB sync job completed',
        );
        return result;
      } catch (err) {
        // TokenRevokedError is terminal, don't retry
        if (err instanceof TokenRevokedError) {
          logger.warn({ jobId: job.id, connectionId }, 'QB token revoked, marking job unrecoverable');
          throw new Error(`Token revoked: ${err.message}`);
        }
        throw err;
      }
    },
    {
      connection: connectionOptions(),
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attemptsMade: job?.attemptsMade, err },
      'QB sync job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'QB sync worker error');
  });

  logger.info({ concurrency: WORKER_CONCURRENCY }, 'QB sync worker started');
  return worker;
}

export async function shutdownWorker(): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (worker) {
    logger.info({}, 'Closing QB sync worker');
    tasks.push(worker.close());
  }
  if (queue) tasks.push(queue.close());

  await Promise.allSettled(tasks);

  worker = null;
  queue = null;
}
