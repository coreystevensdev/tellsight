import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDatasetsByOrg = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockSetActiveDataset = vi.fn();
const mockInfo = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  datasetsQueries: { getDatasetsByOrg: mockGetDatasetsByOrg },
  orgsQueries: {
    getActiveDatasetId: mockGetActiveDatasetId,
    setActiveDataset: mockSetActiveDataset,
  },
}));
vi.mock('../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: mockInfo, warn: vi.fn(), error: vi.fn() },
}));

const { claimDashboardForFirstRealSource } = await import('./activeDataset.js');

const seed = { id: 1, isSeedData: true };
const csv = { id: 2, isSeedData: false };
const connector = { id: 3, isSeedData: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetActiveDatasetId.mockResolvedValue(1);
  mockGetDatasetsByOrg.mockResolvedValue([seed, connector]);
});

/**
 * DW-296. Every connector used to claim the dashboard unconditionally on an
 * initial sync, which encodes "most recently connected wins". The rule here is
 * narrower: claim only for an org's first real source.
 *
 * The case that drove it is asymmetry of harm. An owner migrating from
 * QuickBooks to Xero wants the switch, is watching for it, and is one click
 * from it at Settings -> Datasets -> Set active. An owner who did not want it
 * is not watching, which is how a hand-enqueued backfill repointed org 2 on
 * 2026-11-19 and went unnoticed for two days.
 */
describe('claimDashboardForFirstRealSource', () => {
  it('claims when the only other dataset is the seeded sample', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([seed, connector]);

    await expect(claimDashboardForFirstRealSource(7, 3)).resolves.toBe(true);
    expect(mockSetActiveDataset).toHaveBeenCalledWith(7, 3, expect.anything());
  });

  it('claims when this is the org\'s only dataset at all', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([connector]);

    await expect(claimDashboardForFirstRealSource(7, 3)).resolves.toBe(true);
  });

  // The behaviour change. Connecting a bank feed next to QuickBooks used to
  // move the dashboard onto the feed, and a feed carries transactions without
  // accounting structure, so margin, break-even and concentration stop
  // computing and cash_flow is suppressed outright. Nothing errors.
  it('leaves the dashboard alone when the org already has a real source', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([seed, csv, connector]);

    await expect(claimDashboardForFirstRealSource(7, 3)).resolves.toBe(false);
    expect(mockSetActiveDataset).not.toHaveBeenCalled();
  });

  it('does not count itself as the other real source', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([seed, connector]);

    await claimDashboardForFirstRealSource(7, 3);

    expect(mockSetActiveDataset).toHaveBeenCalled();
  });

  /**
   * A null pointer outranks the rule above, and the Square connector already
   * special-cased it before this helper existed. The dashboard falls back to
   * `datasets[0]` and looks healthy, but the digest, alerts and agent
   * eligibility queries all require a non-null pointer and none of them falls
   * back, so the org goes silent on every one of them.
   */
  it('claims even against other real sources when nothing is active', async () => {
    mockGetActiveDatasetId.mockResolvedValue(null);
    mockGetDatasetsByOrg.mockResolvedValue([seed, csv, connector]);

    await expect(claimDashboardForFirstRealSource(7, 3)).resolves.toBe(true);
    expect(mockSetActiveDataset).toHaveBeenCalledWith(7, 3, expect.anything());
  });

  // The manual route logs its equivalent with previousDatasetId and this path
  // logged nothing, which is why tracing a repointed dashboard took twenty
  // minutes rather than one grep.
  it('logs the move with what it replaced', async () => {
    mockGetActiveDatasetId.mockResolvedValue(9);
    mockGetDatasetsByOrg.mockResolvedValue([seed, connector]);

    await claimDashboardForFirstRealSource(7, 3);

    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 7, datasetId: 3, previousDatasetId: 9 }),
      expect.stringContaining('claimed the dashboard'),
    );
  });

  it('logs the decision not to move, so the absence is explainable too', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([seed, csv, connector]);

    await claimDashboardForFirstRealSource(7, 3);

    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 7, otherRealSources: 1 }),
      expect.stringContaining('leaving the dashboard'),
    );
  });
});
