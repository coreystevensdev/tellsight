import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindEligibleOrgs = vi.fn();
const mockEvaluateOrgQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string, public opts: unknown) {}
  },
}));

vi.mock('../../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/queries/index.js', () => ({
  agentEligibilityQueries: {
    findEligibleOrgs: mockFindEligibleOrgs,
  },
}));

vi.mock('../queue.js', async () => {
  const actual = await vi.importActual<typeof import('../queue.js')>('../queue.js');
  return {
    ...actual,
    getEvaluateOrgQueue: () => ({ add: mockEvaluateOrgQueueAdd }),
  };
});

const { handleOrchestratorJob } = await import('./orchestrator.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('handleOrchestratorJob', () => {
  it('enqueues one agent-eval job per eligible org', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
    ]);

    await handleOrchestratorJob({ id: 'orch-1', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledTimes(2);
    const firstCall = mockEvaluateOrgQueueAdd.mock.calls[0]!;
    expect(firstCall[0]).toMatch(/^agent-eval-10-100-\d{4}-\d{2}-\d{2}$/);
    expect(firstCall[1]).toMatchObject({ orgId: 10, datasetId: 100 });
    expect(firstCall[2]).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
  });

  it('date-stamps the jobId so the same org+dataset gets a fresh id on a later night', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([{ id: 10, activeDatasetId: 100 }]);
    vi.useFakeTimers().setSystemTime(new Date('2026-08-01T03:00:00Z'));

    await handleOrchestratorJob({ id: 'orch-date-1', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockEvaluateOrgQueueAdd.mock.calls[0]![0]).toBe('agent-eval-10-100-2026-08-01');

    mockFindEligibleOrgs.mockResolvedValueOnce([{ id: 10, activeDatasetId: 100 }]);
    vi.setSystemTime(new Date('2026-08-02T03:00:00Z'));

    await handleOrchestratorJob({ id: 'orch-date-2', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockEvaluateOrgQueueAdd.mock.calls[1]![0]).toBe('agent-eval-10-100-2026-08-02');
    expect(mockEvaluateOrgQueueAdd.mock.calls[0]![0]).not.toBe(mockEvaluateOrgQueueAdd.mock.calls[1]![0]);
  });

  it('swaps the cron-bootstrap placeholder for a real correlationId shared across the batch', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
    ]);

    await handleOrchestratorJob({ id: 'orch-2', data: { correlationId: 'cron-bootstrap' } } as never);

    const ids = mockEvaluateOrgQueueAdd.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe('cron-bootstrap');
  });

  it('preserves a real incoming correlationId unchanged', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([{ id: 1, activeDatasetId: 1 }]);

    await handleOrchestratorJob({ id: 'orch-2b', data: { correlationId: 'req-abc' } } as never);

    const call = mockEvaluateOrgQueueAdd.mock.calls[0]!;
    expect((call[1] as { correlationId: string }).correlationId).toBe('req-abc');
  });

  it('continues the batch when one enqueue throws', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
      { id: 8, activeDatasetId: 300 },
    ]);
    mockEvaluateOrgQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis blip'))
      .mockResolvedValueOnce(undefined);

    await expect(
      handleOrchestratorJob({ id: 'orch-3', data: { correlationId: 'cron-bootstrap' } } as never),
    ).resolves.toBeUndefined();

    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledTimes(3);
  });

  it('stops paging once a page returns fewer than pageSize rows', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([{ id: 1, activeDatasetId: 1 }]);

    await handleOrchestratorJob({ id: 'orch-4', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockFindEligibleOrgs).toHaveBeenCalledTimes(1);
    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('exits cleanly when no eligible orgs exist', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([]);

    await handleOrchestratorJob({ id: 'orch-5', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
  });

  it('lets DB errors during eligibility lookup propagate so BullMQ retries', async () => {
    const err = new Error('connection refused');
    mockFindEligibleOrgs.mockRejectedValueOnce(err);

    await expect(
      handleOrchestratorJob({ id: 'orch-6', data: { correlationId: 'cron-bootstrap' } } as never),
    ).rejects.toBe(err);
  });

  it('skips and logs a warning on an invalid job payload', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({ id: 'orch-bad-1', data: {} } as never);

    expect(mockFindEligibleOrgs).not.toHaveBeenCalled();
    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'orch-bad-1' }),
      'invalid job payload, skipping',
    );
  });
});
