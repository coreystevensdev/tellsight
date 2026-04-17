import { Queue, Worker } from 'bullmq';
import type { ConnectionOptions, Job } from 'bullmq';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { processAllDigests } from './digestService.js';

export const DIGEST_QUEUE_NAME = 'email-digest';

let queue: Queue | null = null;
let worker: Worker | null = null;

function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

export function getDigestQueue(): Queue {
  if (!queue) {
    queue = new Queue(DIGEST_QUEUE_NAME, { connection: connectionOptions() });
  }
  return queue;
}

export function initDigestWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(
    DIGEST_QUEUE_NAME,
    async (job: Job) => {
      logger.info({ jobId: job.id }, 'Processing weekly digest batch');

      const results = await processAllDigests();
      const totalSent = results.reduce((n, r) => n + r.emailsSent, 0);

      logger.info(
        { jobId: job.id, orgs: results.length, totalSent },
        'Weekly digest batch completed',
      );

      return { orgs: results.length, totalSent };
    },
    {
      connection: connectionOptions(),
      concurrency: 1, // one batch at a time
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, 'Digest batch failed');
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'Digest worker error');
  });

  logger.info({}, 'Email digest worker started');
  return worker;
}

export async function shutdownDigestWorker(): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  if (worker) tasks.push(worker.close());
  if (queue) tasks.push(queue.close());
  await Promise.allSettled(tasks);
  worker = null;
  queue = null;
}
