import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExpireCorrections = vi.fn();
const mockMarkStale = vi.fn().mockResolvedValue(undefined);
const mockGetApprovedCorrections = vi.fn().mockResolvedValue([]);
const mockOrphanCorrections = vi.fn().mockResolvedValue([]);
const mockGetRowsByDataset = vi.fn().mockResolvedValue([]);
const mockComputeStats = vi.fn().mockReturnValue([]);
const mockAssignIds = vi.fn().mockReturnValue([]);

vi.mock('../../../lib/db.js', () => ({ dbAdmin: { __tag: 'dbAdmin' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../db/queries/index.js', () => ({
  statCorrectionsQueries: {
    expireCorrections: mockExpireCorrections,
    getApprovedCorrections: mockGetApprovedCorrections,
    orphanCorrections: mockOrphanCorrections,
  },
  aiSummariesQueries: { markStale: mockMarkStale },
  dataRowsQueries: { getRowsByDataset: mockGetRowsByDataset },
}));
vi.mock('../../../services/curation/computation.js', () => ({
  computeStats: mockComputeStats,
  assignIds: mockAssignIds,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkStale.mockResolvedValue(undefined);
  mockGetApprovedCorrections.mockResolvedValue([]);
  mockOrphanCorrections.mockResolvedValue([]);
  mockGetRowsByDataset.mockResolvedValue([]);
  mockComputeStats.mockReturnValue([]);
  mockAssignIds.mockReturnValue([]);
});

describe('handleExpireJob', () => {
  it('sweeps expired corrections and logs how many flipped', async () => {
    const { logger } = await import('../../../lib/logger.js');
    const { handleExpireJob } = await import('./expire.js');

    mockExpireCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5 },
      { id: 2, orgId: 10, datasetId: 5 },
      { id: 3, orgId: 20, datasetId: 8 },
    ]);

    await handleExpireJob({ id: 'sweep-1' } as never);

    expect(mockExpireCorrections).toHaveBeenCalledWith(expect.any(Date), { __tag: 'dbAdmin' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ expiredCount: 3, expiredIds: [1, 2, 3] }),
      'Stat correction expiry sweep complete',
    );
  });

  it('invalidates the ai_summaries cache once per distinct org+dataset pair (AC: expiry-side invalidation)', async () => {
    const { handleExpireJob } = await import('./expire.js');

    mockExpireCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5 },
      { id: 2, orgId: 10, datasetId: 5 },
      { id: 3, orgId: 20, datasetId: 8 },
    ]);

    await handleExpireJob({ id: 'sweep-2' } as never);

    expect(mockMarkStale).toHaveBeenCalledTimes(2);
    expect(mockMarkStale).toHaveBeenCalledWith(10, { __tag: 'dbAdmin' }, 5);
    expect(mockMarkStale).toHaveBeenCalledWith(20, { __tag: 'dbAdmin' }, 8);
  });

  it('logs zero and skips markStale without error when nothing has expired', async () => {
    const { handleExpireJob } = await import('./expire.js');
    mockExpireCorrections.mockResolvedValueOnce([]);

    await expect(handleExpireJob({ id: 'sweep-3' } as never)).resolves.toBeUndefined();
    expect(mockMarkStale).not.toHaveBeenCalled();
  });

  it('leaves an Anomaly correction untouched when its id still matches a fresh recompute', async () => {
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5, statInstanceId: '5:anomaly:Sales:v500' },
    ]);
    mockGetRowsByDataset.mockResolvedValueOnce([{ id: 1 }]);
    mockAssignIds.mockReturnValueOnce([{ id: '5:anomaly:Sales:v500' }]);

    const { handleExpireJob } = await import('./expire.js');
    await handleExpireJob({ id: 'sweep-4' } as never);

    expect(mockGetRowsByDataset).toHaveBeenCalledWith(10, 5, { __tag: 'dbAdmin' });
    expect(mockOrphanCorrections).not.toHaveBeenCalled();
  });

  it('flips a drifted Anomaly correction to orphaned and logs the change', async () => {
    const { logger } = await import('../../../lib/logger.js');
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5, statInstanceId: '5:anomaly:Sales:v500' },
    ]);
    mockGetRowsByDataset.mockResolvedValueOnce([{ id: 1 }]);
    mockAssignIds.mockReturnValueOnce([{ id: '5:anomaly:Sales:v640' }]);
    mockOrphanCorrections.mockResolvedValueOnce([1]);

    const { handleExpireJob } = await import('./expire.js');
    await handleExpireJob({ id: 'sweep-5' } as never);

    expect(mockOrphanCorrections).toHaveBeenCalledWith([1], { __tag: 'dbAdmin' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedCount: 1, orphanedIds: [1] }),
      'Stat correction anomaly re-validation sweep complete',
    );
  });

  it('never recomputes for a non-Anomaly correction', async () => {
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 2, orgId: 10, datasetId: 5, statInstanceId: '5:runway:_:_' },
    ]);

    const { handleExpireJob } = await import('./expire.js');
    await handleExpireJob({ id: 'sweep-6' } as never);

    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
    expect(mockOrphanCorrections).not.toHaveBeenCalled();
  });

  it('groups multiple Anomaly corrections against the same dataset into one recompute', async () => {
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5, statInstanceId: '5:anomaly:Sales:v500' },
      { id: 2, orgId: 10, datasetId: 5, statInstanceId: '5:anomaly:Expenses:v200' },
    ]);
    mockGetRowsByDataset.mockResolvedValueOnce([{ id: 1 }]);
    mockAssignIds.mockReturnValueOnce([{ id: '5:anomaly:Sales:v500' }]);
    mockOrphanCorrections.mockResolvedValueOnce([2]);

    const { handleExpireJob } = await import('./expire.js');
    await handleExpireJob({ id: 'sweep-7' } as never);

    expect(mockGetRowsByDataset).toHaveBeenCalledTimes(1);
    expect(mockOrphanCorrections).toHaveBeenCalledWith([2], { __tag: 'dbAdmin' });
  });

  it('logs zero and skips orphanCorrections when no approved correction is Anomaly-typed', async () => {
    const { logger } = await import('../../../lib/logger.js');
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 2, orgId: 10, datasetId: 5, statInstanceId: '5:runway:_:_' },
    ]);

    const { handleExpireJob } = await import('./expire.js');
    await handleExpireJob({ id: 'sweep-8' } as never);

    expect(mockOrphanCorrections).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { orphanedCount: 0 },
      'Stat correction anomaly re-validation sweep complete',
    );
  });

  it('logs one dataset\'s recompute failure and still orphans a different dataset\'s drifted correction', async () => {
    const { logger } = await import('../../../lib/logger.js');
    mockExpireCorrections.mockResolvedValueOnce([]);
    mockGetApprovedCorrections.mockResolvedValueOnce([
      { id: 1, orgId: 10, datasetId: 5, statInstanceId: '5:anomaly:Sales:v500' },
      { id: 2, orgId: 20, datasetId: 8, statInstanceId: '8:anomaly:Rent:v900' },
    ]);
    mockGetRowsByDataset.mockRejectedValueOnce(new Error('connection reset'));
    mockGetRowsByDataset.mockResolvedValueOnce([{ id: 2 }]);
    mockAssignIds.mockReturnValueOnce([{ id: '8:anomaly:Rent:v999' }]);
    mockOrphanCorrections.mockResolvedValueOnce([2]);

    const { handleExpireJob } = await import('./expire.js');
    await expect(handleExpireJob({ id: 'sweep-9' } as never)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 10, datasetId: 5 }),
      'Failed to recompute stats for anomaly correction re-validation; corrections for this dataset stay approved until the next sweep',
    );
    expect(mockOrphanCorrections).toHaveBeenCalledWith([2], { __tag: 'dbAdmin' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ orphanedCount: 1, orphanedIds: [2] }),
      'Stat correction anomaly re-validation sweep complete',
    );
  });
});
