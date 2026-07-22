import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExpireCorrections = vi.fn();
const mockMarkStale = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/db.js', () => ({ dbAdmin: { __tag: 'dbAdmin' } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../db/queries/index.js', () => ({
  statCorrectionsQueries: { expireCorrections: mockExpireCorrections },
  aiSummariesQueries: { markStale: mockMarkStale },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockMarkStale.mockResolvedValue(undefined);
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
});
