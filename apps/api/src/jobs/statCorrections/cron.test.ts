import { describe, it, expect, vi, beforeEach } from 'vitest';

interface RepeatableJobMeta {
  key: string;
  pattern: string;
  name: string;
}

const repeatableJobs = new Map<string, RepeatableJobMeta>();

const mockQueueAdd = vi.fn(
  async (
    name: string,
    _data: unknown,
    opts: { repeat?: { pattern: string; key: string } },
  ) => {
    if (opts?.repeat?.key) {
      repeatableJobs.set(opts.repeat.key, {
        key: opts.repeat.key,
        pattern: opts.repeat.pattern,
        name,
      });
    }
    return undefined;
  },
);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockRemoveJobScheduler = vi.fn(async (key: string) => {
  return repeatableJobs.delete(key);
});
const mockGetRepeatableJobs = vi.fn(async () => Array.from(repeatableJobs.values()));

class FakeQueue {
  add = mockQueueAdd;
  close = mockQueueClose;
  removeJobScheduler = mockRemoveJobScheduler;
  getRepeatableJobs = mockGetRepeatableJobs;
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
  repeatableJobs.clear();
});

describe('initStatCorrectionsCronJob', () => {
  it('registers the repeatable expiry job with the right pattern + key', async () => {
    const { initStatCorrectionsCronJob } = await import('./cron.js');

    await initStatCorrectionsCronJob();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'stat-corrections-expire',
      {},
      expect.objectContaining({
        repeat: expect.objectContaining({ pattern: '0 3 * * *', key: 'stat-corrections-expire' }),
        attempts: 3,
        backoff: expect.objectContaining({ type: 'exponential', delay: 60_000 }),
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      }),
    );
  });

  it('is idempotent across two calls (getRepeatableJobs returns one entry)', async () => {
    const { initStatCorrectionsCronJob } = await import('./cron.js');
    const { getExpireQueue } = await import('./queue.js');

    await initStatCorrectionsCronJob();
    await initStatCorrectionsCronJob();

    const queue = getExpireQueue() as unknown as FakeQueue;
    const jobs = await queue.getRepeatableJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'stat-corrections-expire', pattern: '0 3 * * *' });
  });

  it('re-registering after shutdown lands a fresh single repeatable', async () => {
    const { initStatCorrectionsCronJob, shutdownStatCorrectionsCron } = await import('./cron.js');
    const { getExpireQueue } = await import('./queue.js');

    await initStatCorrectionsCronJob();
    await shutdownStatCorrectionsCron();

    const queue = getExpireQueue() as unknown as FakeQueue;
    expect(await queue.getRepeatableJobs()).toHaveLength(0);

    await initStatCorrectionsCronJob();
    expect(await queue.getRepeatableJobs()).toHaveLength(1);
  });
});

describe('shutdownStatCorrectionsCron', () => {
  it('removes the scheduler by key', async () => {
    const { shutdownStatCorrectionsCron } = await import('./cron.js');

    await shutdownStatCorrectionsCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('stat-corrections-expire');
  });
});
