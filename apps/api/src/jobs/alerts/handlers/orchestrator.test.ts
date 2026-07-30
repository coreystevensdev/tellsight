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
  alertEligibilityQueries: {
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
});

describe('handleOrchestratorJob: cron trigger', () => {
  it('enqueues one alert-evaluate job per eligible org with trigger=cron', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
    ]);

    await handleOrchestratorJob({ id: 'orch-1', data: { correlationId: 'cron-bootstrap' } } as never);

    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledTimes(2);
    const firstCall = mockEvaluateOrgQueueAdd.mock.calls[0]!;
    expect(firstCall[0]).toBe('alert-evaluate-10-100');
    expect(firstCall[1]).toMatchObject({ orgId: 10, datasetId: 100, trigger: 'cron' });
    expect(firstCall[2]).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
  });

  it('shares a single correlationId across all fanned-out jobs', async () => {
    mockFindEligibleOrgs.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
    ]);

    await handleOrchestratorJob({ id: 'orch-2', data: { correlationId: 'cron-bootstrap' } } as never);

    const ids = mockEvaluateOrgQueueAdd.mock.calls.map((c) => (c[1] as { correlationId: string }).correlationId);
    expect(new Set(ids).size).toBe(1);
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
});

describe('handleOrchestratorJob: on-upload trigger', () => {
  it('enqueues exactly one evaluate-org job for the triggering org/dataset, skipping the eligibility page entirely', async () => {
    await handleOrchestratorJob({
      id: 'orch-7',
      data: { orgId: 42, datasetId: 7, correlationId: 'req-abc' },
    } as never);

    expect(mockFindEligibleOrgs).not.toHaveBeenCalled();
    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockEvaluateOrgQueueAdd).toHaveBeenCalledWith(
      'alert-evaluate-42-7',
      { orgId: 42, datasetId: 7, trigger: 'on-upload', correlationId: 'req-abc' },
      expect.objectContaining({ attempts: 3 }),
    );
  });
});

describe('handleOrchestratorJob: invalid job payload', () => {
  it('skips and logs a warning when correlationId is missing', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({ id: 'orch-bad-1', data: { orgId: 10, datasetId: 100 } } as never);

    expect(mockFindEligibleOrgs).not.toHaveBeenCalled();
    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'orch-bad-1' }),
      'invalid job payload, skipping',
    );
  });

  it('skips and logs a warning when orgId is the wrong type', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({
      id: 'orch-bad-2',
      data: { orgId: '42', datasetId: 7, correlationId: 'req-xyz' },
    } as never);

    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'req-xyz', jobId: 'orch-bad-2' }),
      'invalid job payload, skipping',
    );
  });

  it('skips and logs a warning when only orgId is defined', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({
      id: 'orch-bad-3',
      data: { orgId: 42, correlationId: 'req-only-org' },
    } as never);

    expect(mockFindEligibleOrgs).not.toHaveBeenCalled();
    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'orch-bad-3', correlationId: 'req-only-org', orgId: 42 }),
      'malformed job payload: exactly one of orgId/datasetId defined, skipping',
    );
  });

  it('skips and logs a warning when only datasetId is defined', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({
      id: 'orch-bad-4',
      data: { datasetId: 7, correlationId: 'req-only-dataset' },
    } as never);

    expect(mockFindEligibleOrgs).not.toHaveBeenCalled();
    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'orch-bad-4', correlationId: 'req-only-dataset', datasetId: 7 }),
      'malformed job payload: exactly one of orgId/datasetId defined, skipping',
    );
  });

  it('treats orgId: 0 as defined, not falsy, when datasetId is missing', async () => {
    const { logger } = await import('../../../lib/logger.js');

    await handleOrchestratorJob({
      id: 'orch-bad-5',
      data: { orgId: 0, correlationId: 'req-zero-org' },
    } as never);

    expect(mockEvaluateOrgQueueAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'orch-bad-5', orgId: 0 }),
      'malformed job payload: exactly one of orgId/datasetId defined, skipping',
    );
  });
});
