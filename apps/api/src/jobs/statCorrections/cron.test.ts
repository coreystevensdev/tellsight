import { describe, it, expect, vi, beforeEach } from 'vitest';

interface SchedulerMeta {
  key: string;
  pattern: string;
  name: string;
}

const schedulers = new Map<string, SchedulerMeta>();

const mockUpsertJobScheduler = vi.fn(
  async (
    schedulerId: string,
    repeatOpts: { pattern: string },
    template: { name?: string },
  ) => {
    // Same id on a second upsert overwrites the slot, so the slot count stays one.
    schedulers.set(schedulerId, {
      key: schedulerId,
      pattern: repeatOpts.pattern,
      name: template?.name ?? schedulerId,
    });
    return undefined;
  },
);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockRemoveJobScheduler = vi.fn(async (key: string) => {
  return schedulers.delete(key);
});
const mockGetJobSchedulers = vi.fn(async () => Array.from(schedulers.values()));

class FakeQueue {
  upsertJobScheduler = mockUpsertJobScheduler;
  close = mockQueueClose;
  removeJobScheduler = mockRemoveJobScheduler;
  getJobSchedulers = mockGetJobSchedulers;
  constructor(public name: string, public opts: unknown) {}
}

vi.mock('bullmq', () => ({ Queue: FakeQueue }));
vi.mock('../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  schedulers.clear();
});

describe('initStatCorrectionsCronJob', () => {
  it('registers the scheduled expiry job with the right pattern + id', async () => {
    const { initStatCorrectionsCronJob } = await import('./cron.js');

    await initStatCorrectionsCronJob();

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'stat-corrections-expire',
      { pattern: '0 3 * * *' },
      expect.objectContaining({
        name: 'stat-corrections-expire',
        data: {},
        opts: expect.objectContaining({
          attempts: 3,
          backoff: expect.objectContaining({ type: 'exponential', delay: 60_000 }),
          removeOnComplete: { count: 50 },
          removeOnFail: { age: 30 * 86_400 },
        }),
      }),
    );
  });

  it('is idempotent across two calls (getJobSchedulers returns one entry)', async () => {
    const { initStatCorrectionsCronJob } = await import('./cron.js');
    const { getExpireQueue } = await import('./queue.js');

    await initStatCorrectionsCronJob();
    await initStatCorrectionsCronJob();

    const queue = getExpireQueue() as unknown as FakeQueue;
    const jobs = await queue.getJobSchedulers();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'stat-corrections-expire', pattern: '0 3 * * *' });
  });

  it('re-registering after shutdown lands a fresh single scheduler', async () => {
    const { initStatCorrectionsCronJob, shutdownStatCorrectionsCron } = await import('./cron.js');
    const { getExpireQueue } = await import('./queue.js');

    await initStatCorrectionsCronJob();
    await shutdownStatCorrectionsCron();

    const queue = getExpireQueue() as unknown as FakeQueue;
    expect(await queue.getJobSchedulers()).toHaveLength(0);

    await initStatCorrectionsCronJob();
    expect(await queue.getJobSchedulers()).toHaveLength(1);
  });
});

describe('shutdownStatCorrectionsCron', () => {
  it('removes the scheduler by id', async () => {
    const { shutdownStatCorrectionsCron } = await import('./cron.js');

    await shutdownStatCorrectionsCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('stat-corrections-expire');
  });
});
