import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';

const WORKER_CONCURRENCY = 2;
const RETRY_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 3;

export interface SyncJobData<TTrigger extends string> {
  connectionId: number;
  trigger: TTrigger;
}

interface SyncResult {
  rowsSynced: number;
}

export interface TerminalSyncError {
  message: string;
  reason: string;
}

interface IntegrationSyncWorkerConfig<TTrigger extends string, TResult extends SyncResult> {
  label: string;
  queueName: string;
  jobPrefix: string;
  runSync: (connectionId: number, trigger: TTrigger) => Promise<TResult>;
  classifyTerminalError: (error: unknown) => TerminalSyncError | null;
}

function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    // BullMQ requires maxRetriesPerRequest: null on worker connections.
    maxRetriesPerRequest: null,
  };
}

/**
 * Builds one provider's queue/worker lifecycle while keeping its singleton
 * state isolated from every other provider instance.
 */
export function createIntegrationSyncWorker<TTrigger extends string, TResult extends SyncResult>(
  config: IntegrationSyncWorkerConfig<TTrigger, TResult>,
) {
  let queue: Queue | null = null;
  let worker: Worker | null = null;

  function getSyncQueue(): Queue {
    if (!queue) {
      queue = new Queue(config.queueName, { connection: connectionOptions() });
    }
    return queue;
  }

  async function enqueueSyncJob(connectionId: number, trigger: TTrigger): Promise<void> {
    const syncQueue = getSyncQueue();
    await syncQueue.add(
      `${config.jobPrefix}-${trigger}-${connectionId}`,
      { connectionId, trigger },
      {
        attempts: MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
        removeOnComplete: { age: 86_400, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    );
    logger.info({ connectionId, trigger }, `Enqueued ${config.label} sync job`);
  }

  function initSyncWorker(): Worker {
    if (worker) return worker;

    worker = new Worker(
      config.queueName,
      async (job: Job) => {
        const { connectionId, trigger } = job.data as SyncJobData<TTrigger>;
        logger.info(
          { jobId: job.id, connectionId, trigger },
          `Processing ${config.label} sync job`,
        );

        try {
          const result = await config.runSync(connectionId, trigger);
          logger.info(
            { jobId: job.id, connectionId, rowsSynced: result.rowsSynced },
            `${config.label} sync job completed`,
          );
          return result;
        } catch (error) {
          const terminal = config.classifyTerminalError(error);
          if (terminal) {
            logger.warn(
              { jobId: job.id, connectionId },
              `${config.label} ${terminal.reason}, marking job unrecoverable`,
            );
            throw new UnrecoverableError(terminal.message);
          }
          throw error;
        }
      },
      {
        connection: connectionOptions(),
        concurrency: WORKER_CONCURRENCY,
      },
    );

    worker.on('failed', (job, error) => {
      logger.error(
        { jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
        `${config.label} sync job failed`,
      );
    });

    worker.on('error', (error) => {
      logger.error({ err: error }, `${config.label} sync worker error`);
    });

    logger.info({ concurrency: WORKER_CONCURRENCY }, `${config.label} sync worker started`);
    return worker;
  }

  async function shutdownWorker(): Promise<void> {
    const tasks: Promise<unknown>[] = [];

    if (worker) {
      logger.info({}, `Closing ${config.label} sync worker`);
      tasks.push(worker.close());
    }
    if (queue) tasks.push(queue.close());

    await Promise.allSettled(tasks);

    worker = null;
    queue = null;
  }

  return { getSyncQueue, enqueueSyncJob, initSyncWorker, shutdownWorker };
}
