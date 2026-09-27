import { describe, it, expect, vi, beforeEach } from 'vitest';

// Models BullMQ's scheduler-id dedupe behavior: every upsertJobScheduler with
// the same id lands in the same slot, so calling it twice produces ONE
// scheduler, not two. This lets the idempotency test assert the behavioral form
// ("getJobSchedulers returns exactly one entry") instead of the weaker "we
// always pass the right options" form.
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

describe('initDigestCronJob', () => {
  it('registers the scheduled cron job with the right pattern + id', async () => {
    const { initDigestCronJob } = await import('./cron.js');

    await initDigestCronJob();

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'digest-orchestrator',
      { pattern: '0 18 * * 0' },
      expect.objectContaining({
        name: 'digest-orchestrator',
        data: expect.objectContaining({ correlationId: 'cron-bootstrap' }),
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
    const { initDigestCronJob } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initDigestCronJob();
    await initDigestCronJob();

    // The mock Queue models BullMQ's repeat-key dedupe semantic: same key on
    // a second add lands in the same slot. AC #1's behavioral assertion holds
    // here without needing a real Redis.
    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    const jobs = await queue.getJobSchedulers();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'digest-orchestrator', pattern: '0 18 * * 0' });
  });

  it('registers and removes under the same scheduler id', async () => {
    const { initDigestCronJob, shutdownDigestCron } = await import('./cron.js');

    await initDigestCronJob();
    await shutdownDigestCron();

    // If these two ever drift apart, shutdown removes nothing and the old
    // schedule keeps firing from Redis under the id nobody deletes.
    expect(mockUpsertJobScheduler.mock.calls[0]![0]).toBe(
      mockRemoveJobScheduler.mock.calls[0]![0],
    );
  });

  it('re-registering after shutdown lands a fresh single scheduler', async () => {
    const { initDigestCronJob, shutdownDigestCron } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initDigestCronJob();
    await shutdownDigestCron();

    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    expect(await queue.getJobSchedulers()).toHaveLength(0);

    await initDigestCronJob();
    expect(await queue.getJobSchedulers()).toHaveLength(1);
  });
});

describe('shutdownDigestCron', () => {
  it('removes the scheduler by id', async () => {
    const { shutdownDigestCron } = await import('./cron.js');

    await shutdownDigestCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('digest-orchestrator');
  });
});
