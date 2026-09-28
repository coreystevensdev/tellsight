import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same scheduler-id dedupe model as alerts/cron.test.ts: a second upsert with
// the same id overwrites the slot rather than creating a second entry.
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

describe('initAgentOrchestratorCronJob', () => {
  it('registers the scheduled cron job with the right pattern + id', async () => {
    const { initAgentOrchestratorCronJob } = await import('./cron.js');

    await initAgentOrchestratorCronJob();

    expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
      'agent-orchestrator',
      { pattern: '0 3 * * *' },
      expect.objectContaining({
        name: 'agent-orchestrator',
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
    const { initAgentOrchestratorCronJob } = await import('./cron.js');
    const { getOrchestratorQueue } = await import('./queue.js');

    await initAgentOrchestratorCronJob();
    await initAgentOrchestratorCronJob();

    const queue = getOrchestratorQueue() as unknown as FakeQueue;
    const jobs = await queue.getJobSchedulers();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ key: 'agent-orchestrator', pattern: '0 3 * * *' });
  });

  it('registers and removes under the same scheduler id', async () => {
    const { initAgentOrchestratorCronJob, shutdownAgentOrchestratorCron } = await import('./cron.js');

    await initAgentOrchestratorCronJob();
    await shutdownAgentOrchestratorCron();

    // If these two ever drift apart, shutdown removes nothing and the old
    // schedule keeps firing from Redis under the id nobody deletes.
    expect(mockUpsertJobScheduler.mock.calls[0]![0]).toBe(
      mockRemoveJobScheduler.mock.calls[0]![0],
    );
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

    const repeatOpts = mockUpsertJobScheduler.mock.calls[0]![1] as { pattern: string };
    const agentHour = Number(repeatOpts.pattern.split(' ')[1]);
    const alertsHour = Number(ALERTS_CRON_PATTERN.split(' ')[1]);
    const digestHour = Number(DIGEST_CRON_PATTERN.split(' ')[1]);

    expect(repeatOpts.pattern).toBe('0 3 * * *');
    expect(agentHour).toBeLessThan(alertsHour);
    expect(agentHour).toBeLessThan(digestHour);
  });
});

describe('shutdownAgentOrchestratorCron', () => {
  it('removes the scheduler by id', async () => {
    const { shutdownAgentOrchestratorCron } = await import('./cron.js');

    await shutdownAgentOrchestratorCron();

    expect(mockRemoveJobScheduler).toHaveBeenCalledWith('agent-orchestrator');
  });
});
