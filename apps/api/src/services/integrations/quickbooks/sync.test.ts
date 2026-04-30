import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetByOrgAndProvider = vi.fn();
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
const mockCreateQbClient = vi.fn();
const mockNormalizeTransactions = vi.fn();
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
    getByOrgAndProvider: mockGetByOrgAndProvider,
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
  createQbClient: mockCreateQbClient,
}));

vi.mock('./normalize.js', () => ({
  normalizeTransactions: mockNormalizeTransactions,
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray) => ({ sql: strings.join('?') }),
}));

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: 10,
    provider: 'quickbooks',
    providerTenantId: 'realm123',
    lastSyncedAt: null,
    ...overrides,
  };
}

function mockQbClient(overrides: Record<string, unknown> = {}) {
  return {
    getCompanyInfo: vi.fn().mockResolvedValue({ companyName: 'Sunrise Cafe' }),
    query: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

import type { NormalizedQbRow } from './types.js';

function normalizedRow(overrides: Partial<NormalizedQbRow> = {}): NormalizedQbRow {
  return {
    sourceType: 'quickbooks',
    sourceId: 'tx-1-line-1',
    date: new Date('2026-04-10'),
    amount: '125.50',
    category: 'Office Supplies',
    parentCategory: 'Expenses',
    label: 'Acme Supplies',
    metadata: { qb_id: 'tx-1', txnType: 'Purchase', docNumber: 'P-001', memo: null, accountCode: 'acc-1' },
    ...overrides,
  };
}

describe('runSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning._result = Promise.resolve([]);
    mockSyncJobCreate.mockResolvedValue({ id: 100, orgId: 10, connectionId: 1 });
    mockGetOrgOwnerId.mockResolvedValue(1);
  });

  it('throws when connection not found', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(null);

    const { runSync } = await import('./sync.js');
    await expect(runSync(999, 'initial')).rejects.toThrow('Connection 999 not found');
  });

  it('creates dataset on initial sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500, name: 'QuickBooks, Sunrise Cafe' });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockCreateDataset).toHaveBeenCalledWith(
      10,
      expect.objectContaining({
        name: 'QuickBooks, Sunrise Cafe',
        sourceType: 'quickbooks',
      }),
      expect.anything(),
    );
  });

  it('reuses existing QB dataset if present', async () => {
    const existing = { id: 400, name: 'QuickBooks, Old Name', sourceType: 'quickbooks' };
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([existing]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(mockCreateDataset).not.toHaveBeenCalled();
    expect(mockUpdateDatasetName).toHaveBeenCalledWith(10, 400, 'QuickBooks, Sunrise Cafe', expect.anything());
  });

  it('sets activeDatasetId only on initial sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockSetActiveDataset).toHaveBeenCalledWith(10, 500, expect.anything());
  });

  it('does not set activeDatasetId on scheduled sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt: new Date() }));
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([{ id: 400, sourceType: 'quickbooks', name: 'QuickBooks, Sunrise Cafe' }]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(mockSetActiveDataset).not.toHaveBeenCalled();
  });

  it('passes lastSyncedAt to incremental queries', async () => {
    const lastSyncedAt = new Date('2026-04-10T00:00:00Z');
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt }));
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([{ id: 400, sourceType: 'quickbooks', name: 'QuickBooks, Sunrise Cafe' }]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(client.query).toHaveBeenCalledWith('Purchase', lastSyncedAt);
  });

  it('passes undefined since for initial sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt: new Date() }));
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(client.query).toHaveBeenCalledWith('Purchase', undefined);
  });

  it('fetches all 13 transaction types', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(client.query).toHaveBeenCalledTimes(13);
  });

  it('marks AI summaries stale after successful sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockMarkStale).toHaveBeenCalledWith(10, expect.anything());
  });

  it('updates sync_jobs on completion', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    const client = mockQbClient({
      query: vi.fn().mockResolvedValue([{ Id: 'tx-1' }]),
    });
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([normalizedRow()]);
    mockReturning._result = Promise.resolve([{ id: 999 }]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        status: 'completed',
        rowsSynced: expect.any(Number),
      }),
      expect.anything(),
    );
  });

  it('updates connection status to idle after sync', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(1, 'syncing', null, expect.anything());
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(1, 'idle', null, expect.anything());
    expect(mockUpdateLastSyncedAt).toHaveBeenCalledWith(1, expect.anything());
  });

  it('marks sync_jobs and connection as failed on error', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockRejectedValueOnce(new Error('Token revoked'));

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'initial')).rejects.toThrow('Token revoked');

    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ status: 'failed', error: 'Token revoked' }),
      expect.anything(),
    );
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(1, 'error', 'Token revoked', expect.anything());
  });

  it('fires integration.synced event with owner userId', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);
    mockGetOrgOwnerId.mockResolvedValueOnce(42);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'manual');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10, 42, 'integration.synced',
      expect.objectContaining({ provider: 'quickbooks', trigger: 'manual' }),
    );
  });

  it('fires integration.sync_failed event on error', async () => {
    mockGetByOrgAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockRejectedValueOnce(new Error('API timeout'));
    mockGetOrgOwnerId.mockResolvedValueOnce(42);

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'scheduled')).rejects.toThrow('API timeout');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10, 42, 'integration.sync_failed',
      expect.objectContaining({ error: 'API timeout' }),
    );
  });
});

describe('upsertRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 for empty array', async () => {
    const { upsertRows } = await import('./sync.js');
    const count = await upsertRows(10, 500, []);
    expect(count).toBe(0);
  });

  it('batches rows in groups of 500', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => normalizedRow({ sourceId: `tx-${i}` }));
    mockReturning._result = Promise.resolve(new Array(500).fill({ id: 1 }));

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, rows);

    // 1200 rows / 500 batch = 3 batches
    expect(mockInsertValues).toHaveBeenCalledTimes(3);
    expect((mockInsertValues.mock.calls[0]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[1]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[2]![0] as unknown[]).length).toBe(200);
  });

  it('uses ON CONFLICT with source_id target', async () => {
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, [normalizedRow()]);

    expect(mockOnConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
      }),
    );
  });

  it('counts affected rows from returning', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => normalizedRow({ sourceId: `tx-${i}` }));
    mockReturning._result = Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const { upsertRows } = await import('./sync.js');
    const count = await upsertRows(10, 500, rows);

    expect(count).toBe(3);
  });
});
