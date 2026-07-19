import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same repeat-key dedupe model as jobs/digest/cron.test.ts: a second add with
// the same key overwrites the slot rather than creating a second entry.
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

describe('initAlertsCronJob', () => {
  it('registers the repeatable cron job with the right pattern + key', async () => {
    const { initAlertsCronJob } = await import('./cron.js');

    await initAlertsCronJob();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'alerts-orchestrator',
      expect.objectContaining({ correlationId: 'cron-bootstrap' }),
      expect.objectContaining({
        repeat: expect.objectContaining({ pattern: '0 6 * * *', key: 'alerts-orchestrator' }),
        attempts: 3,
        backoff: expect.objectContaining({ type: 'exponential', delay: 60_000 }),
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      }),
    );
  });

  it('is idempotent across two calls (getRepeatableJobs returns one entry)', async () => {
    const { initAlertsCronJob } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initAlertsCronJob();
    await initAlertsCronJob();

    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    const jobs = await queue.getRepeatableJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'alerts-orchestrator', pattern: '0 6 * * *' });
  });

  it('keeps repeat.key and jobId aligned so future migrations stay safe', async () => {
    const { initAlertsCronJob } = await import('./cron.js');
    await initAlertsCronJob();

    const opts = mockQueueAdd.mock.calls[0]![2] as unknown as {
      repeat: { key: string };
      jobId: string;
    };
    expect(opts.jobId).toBe(opts.repeat.key);
  });

  it('re-registering after shutdown lands a fresh single repeatable', async () => {
    const { initAlertsCronJob, shutdownAlertsCron } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initAlertsCronJob();
    await shutdownAlertsCron();

    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    expect(await queue.getRepeatableJobs()).toHaveLength(0);

    await initAlertsCronJob();
    expect(await queue.getRepeatableJobs()).toHaveLength(1);
  });
});

describe('shutdownAlertsCron', () => {
  it('removes the scheduler by key', async () => {
    const { shutdownAlertsCron } = await import('./cron.js');

    await shutdownAlertsCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('alerts-orchestrator');
  });
});
