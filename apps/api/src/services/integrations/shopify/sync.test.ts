import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetByIdAndProvider = vi.fn();
const mockUpdateSyncStatus = vi.fn();
const mockUpdateLastSyncedAt = vi.fn();
const mockSyncJobCreate = vi.fn();
const mockSyncJobUpdate = vi.fn();
const mockGetDatasetsByOrg = vi.fn();
const mockCreateDataset = vi.fn();
const mockUpdateDatasetName = vi.fn();
const mockSetActiveDataset = vi.fn();
const mockMarkStale = vi.fn();
const mockGetOrgOwnerId = vi.fn();
const mockCreateShopifyClient = vi.fn();
const mockPaginateAll = vi.fn();
const mockNormalizeOrders = vi.fn();
const mockNormalizeProducts = vi.fn();
const mockTrackEvent = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflict = vi.fn();
const mockReturning = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<unknown[]> };

vi.mock('../../../lib/db.js', () => ({
  dbAdmin: {
    insert: () => ({
      values: (v: unknown) => {
        mockInsertValues(v);
        return {
          onConflictDoUpdate: (c: unknown) => {
            mockOnConflict(c);
            return { returning: () => { mockReturning(); return mockReturning._result; } };
          },
        };
      },
    }),
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/schema.js', () => ({
  dataRows: {
    id: 'id',
    orgId: 'org_id',
    datasetId: 'dataset_id',
    sourceType: 'source_type',
    sourceId: 'source_id',
    category: 'category',
    parentCategory: 'parent_category',
    date: 'date',
    amount: 'amount',
    label: 'label',
    metadata: 'metadata',
  },
}));

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
    updateSyncStatus: mockUpdateSyncStatus,
    updateLastSyncedAt: mockUpdateLastSyncedAt,
  },
  syncJobsQueries: {
    create: mockSyncJobCreate,
    update: mockSyncJobUpdate,
  },
  datasetsQueries: {
    getDatasetsByOrg: mockGetDatasetsByOrg,
    createDataset: mockCreateDataset,
    updateDatasetName: mockUpdateDatasetName,
  },
  orgsQueries: {
    setActiveDataset: mockSetActiveDataset,
  },
  aiSummariesQueries: {
    markStale: mockMarkStale,
  },
  userOrgsQueries: {
    getOrgOwnerId: mockGetOrgOwnerId,
  },
}));

vi.mock('../../analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('./api.js', () => ({
  createShopifyClient: mockCreateShopifyClient,
  paginateAll: mockPaginateAll,
}));

vi.mock('./normalize.js', () => ({
  normalizeOrders: mockNormalizeOrders,
  normalizeProducts: mockNormalizeProducts,
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('?') }),
}));

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: 10,
    provider: 'shopify',
    providerTenantId: 'my-store.myshopify.com',
    lastSyncedAt: null,
    ...overrides,
  };
}

function mockShopifyClient() {
  return { getShopInfo: vi.fn().mockResolvedValue({ shopName: 'My Store' }), query: vi.fn() };
}

describe('runSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning._result = Promise.resolve([]);
    mockSyncJobCreate.mockResolvedValue({ id: 100, orgId: 10, connectionId: 1 });
    mockGetOrgOwnerId.mockResolvedValue(1);
    // paginateAll is called twice per sync (orders, then products); default
    // both to empty unless a test overrides them.
    mockPaginateAll.mockResolvedValue([]);
    mockNormalizeOrders.mockReturnValue([]);
    mockNormalizeProducts.mockReturnValue([]);
  });

  it('throws a terminal ConnectionNotFoundError when connection not found', async () => {
    mockGetByIdAndProvider.mockResolvedValue(null);

    const { runSync } = await import('./sync.js');
    const { ConnectionNotFoundError } = await import('./errors.js');
    await expect(runSync(999, 'initial')).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it('creates a dataset on initial sync and sets it active', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateShopifyClient.mockResolvedValueOnce(mockShopifyClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500, name: 'Shopify, My Store' });

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockCreateDataset).toHaveBeenCalledWith(
      10,
      { name: 'Shopify, My Store', sourceType: 'shopify' },
      expect.anything(),
    );
    expect(mockSetActiveDataset).toHaveBeenCalledWith(10, 500, expect.anything());
  });

  it('reuses an existing Shopify dataset instead of creating a second one', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateShopifyClient.mockResolvedValueOnce(mockShopifyClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([{ id: 500, name: 'Shopify, My Store', sourceType: 'shopify' }]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'manual');

    expect(mockCreateDataset).not.toHaveBeenCalled();
    expect(mockSetActiveDataset).not.toHaveBeenCalled();
  });

  it('does not set the active dataset on a scheduled or manual sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateShopifyClient.mockResolvedValueOnce(mockShopifyClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500, name: 'Shopify, My Store' });

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(mockSetActiveDataset).not.toHaveBeenCalled();
  });

  it('passes an updated_at filter derived from lastSyncedAt on an incremental sync, and none on initial', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(
      mockConnection({ lastSyncedAt: new Date('2026-04-01T00:00:00Z') }),
    );
    mockCreateShopifyClient.mockResolvedValueOnce(mockShopifyClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([{ id: 500, name: 'Shopify, My Store', sourceType: 'shopify' }]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    const ordersCall = mockPaginateAll.mock.calls[0]!;
    expect(ordersCall[3]).toMatchObject({ query: 'updated_at:>2026-04-01T00:00:00.000Z' });
  });

  it('syncs both orders and products, summing their upserted row counts', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateShopifyClient.mockResolvedValueOnce(mockShopifyClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([{ id: 500, name: 'Shopify, My Store', sourceType: 'shopify' }]);
    mockPaginateAll.mockResolvedValueOnce([{ id: 'order-1' }]).mockResolvedValueOnce([{ id: 'product-1' }]);
    mockNormalizeOrders.mockReturnValueOnce([
      { sourceType: 'shopify', sourceId: 'order-1-line-1', date: new Date(), amount: '10', category: 'Mug', parentCategory: 'Income', label: null, metadata: {} },
    ]);
    mockNormalizeProducts.mockReturnValueOnce([
      { sourceType: 'shopify', sourceId: 'product-1', date: new Date(), amount: '50', category: 'Drinkware', parentCategory: 'Other', label: null, metadata: {} },
    ]);
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { runSync } = await import('./sync.js');
    const result = await runSync(1, 'initial');

    expect(result.rowsSynced).toBe(2);
    expect(mockMarkStale).toHaveBeenCalledWith(10, expect.anything());
  });

  it('marks the connection and sync job failed, and re-throws, when the client throws', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateShopifyClient.mockRejectedValueOnce(new Error('boom'));

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'manual')).rejects.toThrow('boom');

    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(1, 'error', 'boom', expect.anything());
    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ status: 'failed', error: 'boom' }),
      expect.anything(),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 1, 'integration.sync_failed', expect.anything());
  });
});
