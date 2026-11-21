import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetByIdAndProvider = vi.fn();
const mockUpdateSyncStatus = vi.fn();
const mockUpdateLastSyncedAt = vi.fn();
const mockJobCreate = vi.fn();
const mockJobUpdate = vi.fn();
const mockGetDatasetsByOrg = vi.fn();
const mockCreateDataset = vi.fn();
const mockUpdateDatasetName = vi.fn();
const mockTouchDataRefreshed = vi.fn();
const mockMarkStale = vi.fn();
// The claim rule moved behind a shared helper. Its decision logic is tested
// in activeDataset.test.ts; these assert only that an initial sync asks.
const mockClaimDashboard = vi.fn();
const mockGetOrgOwnerId = vi.fn();
const mockTrackEvent = vi.fn();
const mockCreateXeroClient = vi.fn();
const mockFetchEntity = vi.fn();
const mockFetchAccountNames = vi.fn();
const mockFetchOrganisationName = vi.fn();

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
    updateSyncStatus: mockUpdateSyncStatus,
    updateLastSyncedAt: mockUpdateLastSyncedAt,
  },
  syncJobsQueries: { create: mockJobCreate, update: mockJobUpdate },
  datasetsQueries: {
    getDatasetsByOrg: mockGetDatasetsByOrg,
    createDataset: mockCreateDataset,
    updateDatasetName: mockUpdateDatasetName,
    touchDataRefreshed: mockTouchDataRefreshed,
  },
  aiSummariesQueries: { markStale: mockMarkStale },
  orgsQueries: { setActiveDataset: mockClaimDashboard },
  userOrgsQueries: { getOrgOwnerId: mockGetOrgOwnerId },
}));
vi.mock('../activeDataset.js', () => ({
  claimDashboardForFirstRealSource: mockClaimDashboard,
}));
vi.mock('../../../lib/db.js', () => ({
  dbAdmin: { transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) },
}));
const mockLogWarn = vi.fn();
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mockLogWarn, error: vi.fn() },
}));
vi.mock('./api.js', () => ({ createXeroClient: mockCreateXeroClient }));
vi.mock('../../analytics/trackEvent.js', () => ({ trackEvent: mockTrackEvent }));

const { runSync } = await import('./sync.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByIdAndProvider.mockResolvedValue({
    id: 5,
    orgId: 2,
    providerTenantId: 'tenant-abc',
    encryptedAccessToken: 'enc',
    lastSyncedAt: new Date('2026-11-01T00:00:00Z'),
  });
  mockJobCreate.mockResolvedValue({ id: 99 });
  mockGetDatasetsByOrg.mockResolvedValue([{ id: 7, sourceType: 'xero', name: 'Xero, Maple Florist' }]);
  mockFetchEntity.mockResolvedValue([]);
  mockFetchAccountNames.mockResolvedValue(new Map());
  mockFetchOrganisationName.mockResolvedValue('Maple Florist');
  mockCreateXeroClient.mockResolvedValue({
    fetchEntity: mockFetchEntity,
    fetchAccountNames: mockFetchAccountNames,
    fetchOrganisationName: mockFetchOrganisationName,
  });
  mockGetOrgOwnerId.mockResolvedValue(1);
});

function entitiesFetched() {
  return mockFetchEntity.mock.calls.map(([entity]) => entity as string);
}

describe('what gets fetched', () => {
  it('fetches invoices, bank transactions and credit notes', async () => {
    await runSync(5, 'scheduled');

    expect(entitiesFetched()).toEqual(['Invoices', 'BankTransactions', 'CreditNotes']);
  });

  /**
   * The double-count guard, as a test rather than a comment.
   *
   * A Xero `Payment` settles an invoice that `Invoices` already reported, so
   * fetching both would count the same revenue twice. Xero splits the two
   * cleanly, invoice-backed money is a Payment and money with no invoice is a
   * BankTransaction, which is why this connector needs no de-duplication rule
   * where the QuickBooks one needs two.
   */
  it('never fetches Payments, which would double-count every settled invoice', async () => {
    await runSync(5, 'scheduled');

    expect(entitiesFetched()).not.toContain('Payments');
  });
});

describe('incremental versus wide', () => {
  it.each(['initial', 'backfill'] as const)('fetches everything on a %s', async (trigger) => {
    await runSync(5, trigger);

    for (const [, modifiedSince] of mockFetchEntity.mock.calls) {
      expect(modifiedSince).toBeUndefined();
    }
  });

  it.each(['scheduled', 'manual'] as const)('asks only for changes on a %s', async (trigger) => {
    await runSync(5, trigger);

    for (const [, modifiedSince] of mockFetchEntity.mock.calls) {
      expect(modifiedSince).toEqual(new Date('2026-11-01T00:00:00Z'));
    }
  });

  it('repoints the active dataset on an initial sync', async () => {
    await runSync(5, 'initial');

    expect(mockClaimDashboard).toHaveBeenCalledWith(2, 7);
  });

  // The other half of why trigger is two flags rather than one. A backfill
  // fetches as wide as an initial sync, but repointing here would silently move
  // an org off the dataset it was looking at while an admin re-fetched a
  // connector.
  it('leaves the active dataset alone on a backfill', async () => {
    await runSync(5, 'backfill');

    expect(mockClaimDashboard).not.toHaveBeenCalled();
  });
});

describe('lookups that must not cost a sync', () => {
  // An empty map degrades every category to its account code, which is poor
  // labelling. Throwing would discard the transactions instead.
  it('completes the sync when the accounts lookup fails', async () => {
    mockFetchAccountNames.mockRejectedValueOnce(new Error('403'));

    await expect(runSync(5, 'scheduled')).resolves.toMatchObject({ rowsSynced: 0 });
    expect(mockJobUpdate).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: 'completed' }),
      expect.anything(),
    );
    expect(mockLogWarn).toHaveBeenCalled();
  });

  it('completes the sync when the organisation lookup fails', async () => {
    mockFetchOrganisationName.mockRejectedValueOnce(new Error('403'));

    await expect(runSync(5, 'scheduled')).resolves.toBeTruthy();
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(5, 'idle', null, expect.anything());
  });

  // "Xero, 70784a63-d24b-46a9" on a dashboard is worse than no detail, so the
  // fallback is the provider name and never the tenant GUID.
  it('names a new dataset after the organisation, falling back to Xero alone', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([]);
    mockCreateDataset.mockResolvedValue({ id: 11, sourceType: 'xero', name: 'Xero' });
    mockFetchOrganisationName.mockResolvedValueOnce(null);

    await runSync(5, 'initial');

    expect(mockCreateDataset).toHaveBeenCalledWith(
      2,
      { name: 'Xero', sourceType: 'xero' },
      expect.anything(),
    );
  });

  it('renames the dataset when the organisation was renamed in Xero', async () => {
    mockGetDatasetsByOrg.mockResolvedValue([{ id: 7, sourceType: 'xero', name: 'Xero, Old Name' }]);

    await runSync(5, 'scheduled');

    expect(mockUpdateDatasetName).toHaveBeenCalledWith(2, 7, 'Xero, Maple Florist', expect.anything());
  });
});

describe('failure handling', () => {
  it('marks the job and the connection failed, then rethrows for the worker', async () => {
    mockFetchEntity.mockRejectedValueOnce(new Error('Xero is down'));

    await expect(runSync(5, 'scheduled')).rejects.toThrow('Xero is down');

    expect(mockJobUpdate).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: 'failed', error: 'Xero is down' }),
      expect.anything(),
    );
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(5, 'error', 'Xero is down', expect.anything());
  });

  it('refuses a connection that is gone', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(undefined);

    await expect(runSync(5, 'scheduled')).rejects.toMatchObject({
      name: 'XeroConnectionNotFoundError',
    });
    expect(mockJobCreate).not.toHaveBeenCalled();
  });

  // The freshness column everything gates on, and the summary the owner reads.
  // A sync that writes rows without these leaves the dashboard stale.
  it('touches freshness and invalidates the summary on success', async () => {
    await runSync(5, 'scheduled');

    expect(mockTouchDataRefreshed).toHaveBeenCalledWith(2, 7, expect.anything());
    expect(mockMarkStale).toHaveBeenCalledWith(2, expect.anything());
  });
});
