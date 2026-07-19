import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindEligibleOrgs = vi.fn();
const mockOrgQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: class { constructor(public name: string, public opts: unknown) {} },
}));

vi.mock('../../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/queries/index.js', () => ({
  digestEligibilityQueries: {
    findEligibleOrgs: mockFindEligibleOrgs,
  },
}));

vi.mock('../queue.js', async () => {
  const actual = await vi.importActual<typeof import('../queue.js')>('../queue.js');
  return {
    ...actual,
    getOrgQueue: () => ({ add: mockOrgQueueAdd }),
  };
});

const { handleOrchestratorJob, currentUtcWeek } = await import('./orchestrator.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('currentUtcWeek', () => {
  it('reduces a Sunday cron tick to the same day at 00:00 UTC', () => {
    const cronTick = new Date('2026-05-03T18:00:00.000Z'); // Sunday 18:00 UTC
    const { weekStart, weekEnd } = currentUtcWeek(cronTick);

    expect(weekStart.toISOString()).toBe('2026-05-03T00:00:00.000Z');
    // weekEnd = weekStart + 7d - 1ms => Saturday 23:59:59.999
    expect(weekEnd.toISOString()).toBe('2026-05-09T23:59:59.999Z');
  });

  it('reduces a mid-week moment to the prior Sunday at 00:00 UTC', () => {
    const wednesday = new Date('2026-05-06T14:30:00.000Z');
    const { weekStart } = currentUtcWeek(wednesday);

    expect(weekStart.toISOString()).toBe('2026-05-03T00:00:00.000Z');
  });

  it('handles month/year boundaries', () => {
    const newYearsDay = new Date('2026-01-01T08:00:00.000Z'); // Thursday
    const { weekStart } = currentUtcWeek(newYearsDay);

    // Most recent Sunday before 2026-01-01 (Thursday) is 2025-12-28.
    expect(weekStart.toISOString()).toBe('2025-12-28T00:00:00.000Z');
  });
});

describe('handleOrchestratorJob', () => {
  it('enqueues one digest-org job per eligible org with the correct week window', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, name: 'Acme', activeDatasetId: 100, businessProfile: null },
      { id: 9, name: 'Beta', activeDatasetId: 200, businessProfile: null },
    ]);

    await handleOrchestratorJob({ id: 'orch-1' } as never);

    expect(mockOrgQueueAdd).toHaveBeenCalledTimes(2);
    const firstCall = mockOrgQueueAdd.mock.calls[0]!;
    expect(firstCall[0]).toMatch(/^digest-org-10-\d+$/);
    expect(firstCall[1]).toMatchObject({
      orgId: 10,
      correlationId: expect.any(String),
    });
    expect(firstCall[1].weekStart).toBeInstanceOf(Date);
    expect(firstCall[1].weekEnd).toBeInstanceOf(Date);
    expect(firstCall[2]).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
    });
    // jobId, not name, is what BullMQ actually dedupes on; a retried
    // orchestrator attempt must reuse the same jobId per org per week.
    expect(firstCall[2].jobId).toBe(firstCall[0]);
    expect(firstCall[2].jobId).toMatch(/^digest-org-10-\d+$/);
  });

  it('shares a single correlationId across all per-org jobs in one tick', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, name: 'Acme', activeDatasetId: 100, businessProfile: null },
      { id: 9, name: 'Beta', activeDatasetId: 200, businessProfile: null },
      { id: 8, name: 'Gamma', activeDatasetId: 300, businessProfile: null },
    ]);

    await handleOrchestratorJob({ id: 'orch-2' } as never);

    const ids = mockOrgQueueAdd.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
  });

  it('continues the batch when one enqueue throws (AC #4 isolation)', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, name: 'Acme', activeDatasetId: 100, businessProfile: null },
      { id: 9, name: 'Beta', activeDatasetId: 200, businessProfile: null },
      { id: 8, name: 'Gamma', activeDatasetId: 300, businessProfile: null },
    ]);
    mockOrgQueueAdd
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Redis blip'))
      .mockResolvedValueOnce(undefined);

    await expect(handleOrchestratorJob({ id: 'orch-3' } as never)).resolves.toBeUndefined();

    expect(mockOrgQueueAdd).toHaveBeenCalledTimes(3);
  });

  it('stops looping once a page returns fewer than pageSize rows', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 1, name: 'Solo', activeDatasetId: 1, businessProfile: null },
    ]);

    await handleOrchestratorJob({ id: 'orch-4' } as never);

    expect(mockFindEligibleOrgs).toHaveBeenCalledTimes(1);
    expect(mockOrgQueueAdd).toHaveBeenCalledTimes(1);
  });

  it('exits cleanly when no eligible orgs exist', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([]);

    await handleOrchestratorJob({ id: 'orch-5' } as never);

    expect(mockOrgQueueAdd).not.toHaveBeenCalled();
  });

  it('lets DB errors during eligibility lookup propagate so BullMQ retries', async () => {
    const err = new Error('connection refused');
    mockFindEligibleOrgs.mockRejectedValueOnce(err);

    await expect(handleOrchestratorJob({ id: 'orch-6' } as never)).rejects.toBe(err);
  });
});
