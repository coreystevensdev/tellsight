import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same repeat-key dedupe model as alerts/cron.test.ts: a second add with
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

describe('initAgentOrchestratorCronJob', () => {
  it('registers the repeatable cron job with the right pattern + key', async () => {
    const { initAgentOrchestratorCronJob } = await import('./cron.js');

    await initAgentOrchestratorCronJob();

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'agent-orchestrator',
      expect.objectContaining({ correlationId: 'cron-bootstrap' }),
      expect.objectContaining({
        repeat: expect.objectContaining({ pattern: '0 3 * * *', key: 'agent-orchestrator' }),
        attempts: 3,
        backoff: expect.objectContaining({ type: 'exponential', delay: 60_000 }),
        removeOnComplete: { count: 50 },
        removeOnFail: { age: 30 * 86_400 },
      }),
    );
  });

  it('is idempotent across two calls (getRepeatableJobs returns one entry)', async () => {
    const { initAgentOrchestratorCronJob } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initAgentOrchestratorCronJob();
    await initAgentOrchestratorCronJob();

    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    const jobs = await queue.getRepeatableJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'agent-orchestrator', pattern: '0 3 * * *' });
  });

  it('keeps repeat.key and jobId aligned so future migrations stay safe', async () => {
    const { initAgentOrchestratorCronJob } = await import('./cron.js');
    await initAgentOrchestratorCronJob();

    const opts = mockQueueAdd.mock.calls[0]![2] as unknown as {
      repeat: { key: string };
      jobId: string;
    };
    expect(opts.jobId).toBe(opts.repeat.key);
  });

  it('runs strictly before alerts (0 6 * * *) and digest (0 18 * * 0), not just a different string', async () => {
    // Literal patterns from alerts/cron.ts and digest/cron.ts (not imported;
    // neither module exports its constant). If either sibling's schedule
    // ever moves, update these two literals so this test still proves the
    // three-scheduler ordering the 3am placement is justified by.
    const ALERTS_CRON_PATTERN = '0 6 * * *';
    const DIGEST_CRON_PATTERN = '0 18 * * 0';

    const { initAgentOrchestratorCronJob } = await import('./cron.js');
    await initAgentOrchestratorCronJob();

    const opts = mockQueueAdd.mock.calls[0]![2] as unknown as { repeat: { pattern: string } };
    const agentHour = Number(opts.repeat.pattern.split(' ')[1]);
    const alertsHour = Number(ALERTS_CRON_PATTERN.split(' ')[1]);
    const digestHour = Number(DIGEST_CRON_PATTERN.split(' ')[1]);

    expect(opts.repeat.pattern).toBe('0 3 * * *');
    expect(agentHour).toBeLessThan(alertsHour);
    expect(agentHour).toBeLessThan(digestHour);
  });
});

describe('shutdownAgentOrchestratorCron', () => {
  it('removes the scheduler by key', async () => {
    const { shutdownAgentOrchestratorCron } = await import('./cron.js');

    await shutdownAgentOrchestratorCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('agent-orchestrator');
  });
});
