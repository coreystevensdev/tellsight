import { describe, it, expect, vi, beforeEach } from 'vitest';

const getByIdAndProvider = vi.fn();
const updateSyncStatus = vi.fn();
const updateLastSyncedAt = vi.fn();
const syncJobCreate = vi.fn();
const syncJobUpdate = vi.fn();
const getDatasetsByOrg = vi.fn();
const createDataset = vi.fn();
const updateDatasetName = vi.fn();
const setActiveDataset = vi.fn();
const findOrgById = vi.fn();
const markStale = vi.fn();
const getOrgOwnerId = vi.fn();
const createSquareClient = vi.fn();
const trackEvent = vi.fn();
const returning = vi.fn();

vi.mock('../../../lib/db.js', () => ({
  dbAdmin: {
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => ({ returning: () => returning() }) }),
    }),
  },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../db/schema.js', () => ({
  dataRows: { id: 'id', orgId: 'org_id', sourceId: 'source_id', parentCategory: 'parent_category' },
}));
vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: (...a: unknown[]) => getByIdAndProvider(...a),
    updateSyncStatus: (...a: unknown[]) => updateSyncStatus(...a),
    updateLastSyncedAt: (...a: unknown[]) => updateLastSyncedAt(...a),
  },
  syncJobsQueries: {
    create: (...a: unknown[]) => syncJobCreate(...a),
    update: (...a: unknown[]) => syncJobUpdate(...a),
  },
  datasetsQueries: {
    getDatasetsByOrg: (...a: unknown[]) => getDatasetsByOrg(...a),
    createDataset: (...a: unknown[]) => createDataset(...a),
    updateDatasetName: (...a: unknown[]) => updateDatasetName(...a),
  },
  orgsQueries: {
    setActiveDataset: (...a: unknown[]) => setActiveDataset(...a),
    findOrgById: (...a: unknown[]) => findOrgById(...a),
  },
  aiSummariesQueries: { markStale: (...a: unknown[]) => markStale(...a) },
  userOrgsQueries: { getOrgOwnerId: (...a: unknown[]) => getOrgOwnerId(...a) },
}));
vi.mock('../../analytics/trackEvent.js', () => ({
  trackEvent: (...a: unknown[]) => trackEvent(...a),
}));
vi.mock('./api.js', () => ({ createSquareClient: (...a: unknown[]) => createSquareClient(...a) }));

const { runSync } = await import('./sync.js');

const listLocations = vi.fn();
const searchOrders = vi.fn();

function connection(over: Record<string, unknown> = {}) {
  return { id: 7, orgId: 3, providerTenantId: 'MERCHANT1', lastSyncedAt: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  getByIdAndProvider.mockResolvedValue(connection());
  syncJobCreate.mockResolvedValue({ id: 99 });
  getDatasetsByOrg.mockResolvedValue([]);
  createDataset.mockResolvedValue({ id: 42, sourceType: 'square', name: 'Square, Main St' });
  getOrgOwnerId.mockResolvedValue(5);
  findOrgById.mockResolvedValue({ id: 3, activeDatasetId: 99 });
  returning.mockResolvedValue([{ id: 1 }]);
  listLocations.mockResolvedValue([{ id: 'L1', name: 'Main St' }]);
  searchOrders.mockResolvedValue([]);
  createSquareClient.mockResolvedValue({ listLocations, searchOrders });
});

describe('runSync', () => {
  // Locations have to resolve first: the token names none and SearchOrders
  // refuses an empty list, so the reverse order cannot work at all.
  it('resolves locations before asking for orders', async () => {
    await runSync(7, 'initial');
    expect(listLocations).toHaveBeenCalled();
    expect(searchOrders).toHaveBeenCalled();
    expect(listLocations.mock.invocationCallOrder[0]!).toBeLessThan(
      searchOrders.mock.invocationCallOrder[0]!,
    );
  });

  it('passes every location into the one order query', async () => {
    listLocations.mockResolvedValue([
      { id: 'L1', name: 'A' },
      { id: 'L2', name: 'B' },
    ]);
    await runSync(7, 'initial');
    expect(searchOrders).toHaveBeenCalledWith(['L1', 'L2'], expect.any(Date));
  });

  // A scheduled run picks up where the last one stopped; an initial run has no
  // watermark and SearchOrders still needs a start, hence the bounded lookback.
  it('reads from lastSyncedAt on a scheduled run', async () => {
    const last = new Date('2026-06-01T00:00:00Z');
    getByIdAndProvider.mockResolvedValue(connection({ lastSyncedAt: last }));
    await runSync(7, 'scheduled');
    expect(searchOrders.mock.calls[0]![1]).toEqual(last);
  });

  it('falls back to a bounded lookback on the first run', async () => {
    await runSync(7, 'initial');
    const since = searchOrders.mock.calls[0]![1] as Date;
    const monthsBack = (Date.now() - since.getTime()) / (1000 * 60 * 60 * 24 * 30);
    expect(monthsBack).toBeGreaterThan(22);
    expect(monthsBack).toBeLessThan(26);
  });

  it.each([
    [[{ id: 'L1', name: 'Main St' }], 'Square, Main St'],
    [
      [
        { id: 'L1', name: 'A' },
        { id: 'L2', name: 'B' },
      ],
      'Square, 2 locations',
    ],
    [[], 'Square, MERCHANT1'],
  ])('names the dataset from the locations it found', async (locations, expected) => {
    listLocations.mockResolvedValue(locations);
    await runSync(7, 'initial');
    expect(createDataset).toHaveBeenCalledWith(
      3,
      { name: expected, sourceType: 'square' },
      expect.anything(),
    );
  });

  // Only the first sync may seize the dashboard. A scheduled run stealing the
  // active dataset would move the ground under someone mid-session.
  // An org whose initial sync failed holds rows nothing can display: only an
  // initial run sets the active dataset, and only reconnecting produces another
  // one. Claiming it when the slot is empty costs nothing, because there is no
  // session to pull the ground out from under.
  it('claims the dashboard on a later sync when the org has none', async () => {
    getByIdAndProvider.mockResolvedValue(connection({ lastSyncedAt: new Date() }));
    findOrgById.mockResolvedValue({ id: 3, activeDatasetId: null });

    await runSync(7, 'manual');
    expect(setActiveDataset).toHaveBeenCalledWith(3, 42, expect.anything());
  });

  it('claims the active dataset on the first sync only', async () => {
    await runSync(7, 'initial');
    expect(setActiveDataset).toHaveBeenCalled();

    vi.clearAllMocks();
    getByIdAndProvider.mockResolvedValue(connection({ lastSyncedAt: new Date() }));
    syncJobCreate.mockResolvedValue({ id: 99 });
    getDatasetsByOrg.mockResolvedValue([{ id: 42, sourceType: 'square', name: 'Square, Main St' }]);
    getOrgOwnerId.mockResolvedValue(5);
    findOrgById.mockResolvedValue({ id: 3, activeDatasetId: 99 });
    returning.mockResolvedValue([]);
    createSquareClient.mockResolvedValue({ listLocations, searchOrders });
    await runSync(7, 'scheduled');
    expect(setActiveDataset).not.toHaveBeenCalled();
  });

  it('stales the cached summary so it is recomputed against new rows', async () => {
    await runSync(7, 'initial');
    expect(markStale).toHaveBeenCalledWith(3, expect.anything());
  });

  it('returns the connection to idle and stamps the watermark', async () => {
    await runSync(7, 'initial');
    expect(updateSyncStatus).toHaveBeenCalledWith(7, 'syncing', null, expect.anything());
    expect(updateSyncStatus).toHaveBeenLastCalledWith(7, 'idle', null, expect.anything());
    expect(updateLastSyncedAt).toHaveBeenCalledWith(7, expect.anything());
  });

  // A failure that leaves the row reading "syncing" looks like a slow sync
  // forever, and nothing would ever retry it.
  it('records the error on both the job and the connection when the API fails', async () => {
    searchOrders.mockRejectedValue(new Error('Square 500'));
    await expect(runSync(7, 'initial')).rejects.toThrow('Square 500');

    expect(updateSyncStatus).toHaveBeenLastCalledWith(7, 'error', 'Square 500', expect.anything());
    expect(syncJobUpdate).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: 'failed', error: 'Square 500' }),
      expect.anything(),
    );
    expect(updateLastSyncedAt).not.toHaveBeenCalled();
  });

  it('throws rather than syncing when the connection row is gone', async () => {
    getByIdAndProvider.mockResolvedValue(null);
    await expect(runSync(7, 'initial')).rejects.toThrow(/not found/i);
    expect(syncJobCreate).not.toHaveBeenCalled();
  });
});
