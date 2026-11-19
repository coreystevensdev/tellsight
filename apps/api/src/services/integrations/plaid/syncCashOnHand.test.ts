import { describe, expect, it, vi, beforeEach } from 'vitest';

// runSync records cash on hand so runway and cash_forecast have a starting
// balance, and the decision worth pinning is that it cannot cost a sync. A
// balance endpoint failing must leave the transactions written and the job
// successful: the owner would otherwise see a failed sync and no new rows, for
// a number that is a bonus on top of what they came for.

const mockGetByIdAndProvider = vi.fn();
const mockUpdateSyncStatus = vi.fn();
const mockUpdateLastSyncedAt = vi.fn();
const mockUpdateSyncCursor = vi.fn();
const mockJobCreate = vi.fn();
const mockJobUpdate = vi.fn();
const mockGetDatasetsByOrg = vi.fn();
const mockCreateDataset = vi.fn();
const mockUpdateDatasetName = vi.fn();
const mockTouchDataRefreshed = vi.fn();
const mockMarkStale = vi.fn();
const mockGetOrgOwnerId = vi.fn();
const mockUpdateOrgFinancials = vi.fn();
const mockFetchTransactionsSince = vi.fn();
const mockFetchAccountBalances = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
    updateSyncStatus: mockUpdateSyncStatus,
    updateLastSyncedAt: mockUpdateLastSyncedAt,
    updateSyncCursor: mockUpdateSyncCursor,
  },
  syncJobsQueries: { create: mockJobCreate, update: mockJobUpdate },
  datasetsQueries: {
    getDatasetsByOrg: mockGetDatasetsByOrg,
    createDataset: mockCreateDataset,
    updateDatasetName: mockUpdateDatasetName,
    touchDataRefreshed: mockTouchDataRefreshed,
  },
  aiSummariesQueries: { markStale: mockMarkStale },
  orgFinancialsQueries: { updateOrgFinancials: mockUpdateOrgFinancials },
  userOrgsQueries: { getOrgOwnerId: mockGetOrgOwnerId },
}));
vi.mock('../../../lib/db.js', () => ({
  dbAdmin: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
const mockLogWarn = vi.fn();
const mockLogInfo = vi.fn();
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: mockLogInfo, warn: mockLogWarn, error: vi.fn() },
}));
vi.mock('../encryption.js', () => ({ decrypt: () => 'access-token' }));
vi.mock('./api.js', () => ({
  fetchTransactionsSince: mockFetchTransactionsSince,
  fetchAccountBalances: mockFetchAccountBalances,
}));
vi.mock('../../analytics/trackEvent.js', () => ({ trackEvent: mockTrackEvent }));

const { runSync } = await import('./sync.js');

function depository(available: number) {
  return {
    account_id: 'a',
    name: 'Checking',
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
    balances: { available, current: available, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByIdAndProvider.mockResolvedValue({
    id: 5,
    orgId: 2,
    encryptedAccessToken: 'enc',
    providerTenantId: 'item-1',
    syncCursor: null,
  });
  mockJobCreate.mockResolvedValue({ id: 99 });
  mockGetDatasetsByOrg.mockResolvedValue([{ id: 7, sourceType: 'plaid', name: 'Bank, item-1' }]);
  mockFetchTransactionsSince.mockResolvedValue({
    added: [],
    modified: [],
    removedIds: [],
    cursor: 'cursor-1',
  });
  mockFetchAccountBalances.mockResolvedValue({ accounts: [depository(4200)] });
  mockGetOrgOwnerId.mockResolvedValue(1);
});

describe('runSync recording cash on hand', () => {
  it('writes the bank balance so runway has a starting point', async () => {
    await runSync(5, 'scheduled');

    expect(mockUpdateOrgFinancials).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ cashOnHand: 4200 }),
    );
  });

  it('dates the balance, since the snapshot history is keyed on it', async () => {
    await runSync(5, 'scheduled');

    const [, updates] = mockUpdateOrgFinancials.mock.calls[0]!;
    expect(updates.cashAsOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // The decision this file exists for.
  it('keeps the sync successful when the balance call fails', async () => {
    mockFetchAccountBalances.mockRejectedValueOnce(new Error('PRODUCT_NOT_READY'));
    // The mirror of the assertion below: a real failure does warn.

    await expect(runSync(5, 'scheduled')).resolves.toMatchObject({ rowsSynced: 0 });

    expect(mockJobUpdate).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: 'completed' }),
      expect.anything(),
    );
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(5, 'idle', null, expect.anything());
    expect(mockUpdateOrgFinancials).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalled();
  });

  // A connection whose balances are unusable is not an error either, and must
  // not leave a stale figure looking current.
  it('records nothing when no depository balance is available', async () => {
    mockFetchAccountBalances.mockResolvedValueOnce({
      accounts: [{ ...depository(0), type: 'credit', balances: { ...depository(0).balances, available: null, current: 410 } }],
    });

    await expect(runSync(5, 'scheduled')).resolves.toBeTruthy();
    expect(mockUpdateOrgFinancials).not.toHaveBeenCalled();
    // At info, not warn. Removing the guard produces the same outcome by a
    // different route, a TypeError the catch swallows, and the only thing that
    // distinguishes "this Item has no cash account" from "the balance call
    // broke" is which level it was logged at. Someone reading production logs
    // needs that difference.
    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 2 }),
      expect.stringContaining('No single-currency depository balance'),
    );
  });

  // Ordering: the balance is recorded before the summary is invalidated, so the
  // next AI summary is generated against the new figure rather than the old one.
  it('records the balance before marking the summary stale', async () => {
    const order: string[] = [];
    mockUpdateOrgFinancials.mockImplementation(async () => void order.push('cash'));
    mockMarkStale.mockImplementation(async () => void order.push('stale'));

    await runSync(5, 'scheduled');

    expect(order).toEqual(['cash', 'stale']);
  });
});
