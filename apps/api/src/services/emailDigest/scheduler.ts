import { logger } from '../../lib/logger.js';
import { getDigestQueue } from './worker.js';

const WEEKLY_CRON = '0 19 * * 0'; // Sunday 7pm UTC
const JOB_ID = 'weekly-digest';

export async function initDigestScheduler(): Promise<void> {
  try {
    const queue = getDigestQueue();

    await queue.add(
      JOB_ID,
      {},
      {
        repeat: { pattern: WEEKLY_CRON, key: JOB_ID },
        jobId: JOB_ID,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 86_400, count: 10 },
        removeOnFail: { age: 30 * 86_400 },
      },
    );

    logger.info({ pattern: WEEKLY_CRON }, 'Email digest scheduler initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize digest scheduler');
  }
}
