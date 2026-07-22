import { Worker } from 'bullmq';
import type { Job } from 'bullmq';

import { logger } from '../../lib/logger.js';
import { connectionOptions, QUEUE_EXPIRE } from './queue.js';
import { handleExpireJob } from './handlers/expire.js';

const EXPIRE_CONCURRENCY = 1;

let expireWorker: Worker | null = null;

export function initStatCorrectionsExpireWorker(): Worker {
  if (expireWorker) return expireWorker;

  expireWorker = new Worker(QUEUE_EXPIRE, async (job: Job) => handleExpireJob(job), {
    connection: connectionOptions(),
    concurrency: EXPIRE_CONCURRENCY,
  });
  expireWorker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attemptsMade: job?.attemptsMade, err }, 'Stat corrections worker job failed');
  });
  expireWorker.on('error', (err) => {
    logger.error({ err }, 'Stat corrections worker error');
  });
  logger.info({ concurrency: EXPIRE_CONCURRENCY }, 'Stat corrections expire worker started');
  return expireWorker;
}

export async function shutdownStatCorrectionsWorker(): Promise<void> {
  if (expireWorker) {
    logger.info({}, 'Closing stat corrections expire worker');
    await expireWorker.close();
    expireWorker = null;
  }
}
