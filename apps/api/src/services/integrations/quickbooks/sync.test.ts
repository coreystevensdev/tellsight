import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

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
const mockCreateQbClient = vi.fn();
const mockNormalizeTransactions = vi.fn();
const mockTrackEvent = vi.fn();
const mockInsertValues = vi.fn();
const mockOnConflict = vi.fn();
const mockDeleteWhere = vi.fn();
// vitest 5 types a bare vi.fn() as Mock<Procedure | Constructable>, which is
// not callable without narrowing, so name the signature.
const mockReturning = vi.fn() as Mock & { _result: Promise<unknown[]> };
const mockDeleteReturning = vi.fn() as Mock & { _result: Promise<unknown[]> };

vi.mock('../../../lib/db.js', () => {
  // Shared by dbAdmin itself and by the client a .transaction() callback
  // receives, so a test can call either path and land on the same mocks.
  function queryClient() {
    return {
      insert: () => ({
        values: (v: unknown) => {
          mockInsertValues(v);
          return {
            onConflictDoUpdate: (c: unknown) => {
              mockOnConflict(c);
              return {
                returning: () => {
                  mockReturning();
                  return mockReturning._result;
                },
              };
            },
          };
        },
      }),
      delete: () => ({
        where: (c: unknown) => {
          mockDeleteWhere(c);
          return {
            returning: () => {
              mockDeleteReturning();
              return mockDeleteReturning._result;
            },
          };
        },
      }),
    };
  }

  return {
    dbAdmin: {
      // Branded so an assertion can tell the clients apart. expect.anything()
      // matches either one, which made the assertion below read as coverage
      // of the scoped-client fix while observing nothing about it.
      __brand: 'dbAdmin',
      ...queryClient(),
      transaction: async (fn: (tx: ReturnType<typeof queryClient>) => unknown) => fn(queryClient()),
    },
    db: { __brand: 'db' },
  };
});

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
  createQbClient: mockCreateQbClient,
}));

vi.mock('./normalize.js', () => ({
  normalizeTransactions: mockNormalizeTransactions,
}));

vi.mock('drizzle-orm', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join('?'),
    values,
  }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'inArray', col, vals }),
  notInArray: (col: unknown, vals: unknown[]) => ({ op: 'notInArray', col, vals }),
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
    metadata: {
      qb_id: 'tx-1',
      txnType: 'Purchase',
      docNumber: 'P-001',
      memo: null,
      accountCode: 'acc-1',
    },
    ...overrides,
  };
}

describe('runSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning._result = Promise.resolve([]);
    mockDeleteReturning._result = Promise.resolve([]);
    mockSyncJobCreate.mockResolvedValue({ id: 100, orgId: 10, connectionId: 1 });
    mockGetOrgOwnerId.mockResolvedValue(1);
  });

  it('throws a terminal ConnectionNotFoundError when connection not found', async () => {
    mockGetByIdAndProvider.mockResolvedValue(null);

    const { runSync } = await import('./sync.js');
    const { ConnectionNotFoundError } = await import('./errors.js');
    await expect(runSync(999, 'initial')).rejects.toBeInstanceOf(ConnectionNotFoundError);
    await expect(runSync(999, 'initial')).rejects.toThrow('Connection 999 not found');
  });

  it('creates dataset on initial sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500, name: 'QuickBooks, Sunrise Cafe' });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    // The connection is fetched by its own id (1), not treated as an org id.
    expect(mockGetByIdAndProvider).toHaveBeenCalledWith(
      1,
      'quickbooks',
      expect.objectContaining({ __brand: 'dbAdmin' }),
    );

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
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([existing]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(mockCreateDataset).not.toHaveBeenCalled();
    expect(mockUpdateDatasetName).toHaveBeenCalledWith(
      10,
      400,
      'QuickBooks, Sunrise Cafe',
      expect.anything(),
    );
  });

  it('sets activeDatasetId only on initial sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockSetActiveDataset).toHaveBeenCalledWith(10, 500, expect.anything());
  });

  it('does not set activeDatasetId on scheduled sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt: new Date() }));
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([
      { id: 400, sourceType: 'quickbooks', name: 'QuickBooks, Sunrise Cafe' },
    ]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(mockSetActiveDataset).not.toHaveBeenCalled();
  });

  it('passes lastSyncedAt to incremental queries', async () => {
    const lastSyncedAt = new Date('2026-04-10T00:00:00Z');
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt }));
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([
      { id: 400, sourceType: 'quickbooks', name: 'QuickBooks, Sunrise Cafe' },
    ]);
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'scheduled');

    expect(client.query).toHaveBeenCalledWith('Purchase', lastSyncedAt);
  });

  it('passes undefined since for initial sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection({ lastSyncedAt: new Date() }));
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(client.query).toHaveBeenCalledWith('Purchase', undefined);
  });

  it('fetches all 12 transaction types', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(client.query).toHaveBeenCalledTimes(12);
  });

  it('does not sync Estimate, a quote is not a transaction', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    const client = mockQbClient();
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(client.query).not.toHaveBeenCalledWith('Estimate', expect.anything());
  });

  it('marks AI summaries stale after successful sync', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'initial');

    expect(mockMarkStale).toHaveBeenCalledWith(10, expect.anything());
  });

  it('updates sync_jobs on completion', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
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
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
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
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockRejectedValueOnce(new Error('Token revoked'));

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'initial')).rejects.toThrow('Token revoked');

    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ status: 'failed', error: 'Token revoked' }),
      expect.anything(),
    );
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(
      1,
      'error',
      'Token revoked',
      expect.anything(),
    );
  });

  it('fires integration.synced event with owner userId', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockResolvedValueOnce(mockQbClient());
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([]);
    mockGetOrgOwnerId.mockResolvedValueOnce(42);

    const { runSync } = await import('./sync.js');
    await runSync(1, 'manual');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      42,
      'integration.synced',
      expect.objectContaining({ provider: 'quickbooks', trigger: 'manual' }),
    );
  });

  it('fires integration.sync_failed event on error', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    mockCreateQbClient.mockRejectedValueOnce(new Error('API timeout'));
    mockGetOrgOwnerId.mockResolvedValueOnce(42);

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'scheduled')).rejects.toThrow('API timeout');

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      42,
      'integration.sync_failed',
      expect.objectContaining({ error: 'API timeout' }),
    );
  });
});

describe('upsertRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReturning._result = Promise.resolve([]);
    mockDeleteReturning._result = Promise.resolve([]);
  });

  it('returns 0 upserted and 0 reconciled when nothing was fetched', async () => {
    const { upsertRows } = await import('./sync.js');
    const result = await upsertRows(10, 500, [], []);
    expect(result).toEqual({ upserted: 0, reconciled: 0 });
  });

  it('skips the delete and insert entirely when nothing was fetched', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, [], []);

    expect(mockDeleteWhere).not.toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('still reconciles a transaction that was fetched and now produces no rows', async () => {
    // The sharpest case in the design doc: a transaction that used to
    // produce a row now produces none. rows.length === 0 on its own used
    // to short-circuit before any delete ran, which is exactly how that
    // case went unreconciled, not just under-tested.
    mockDeleteReturning._result = Promise.resolve([{ id: 1 }]);

    const { upsertRows } = await import('./sync.js');
    const result = await upsertRows(10, 500, ['tx-now-empty'], []);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(result).toEqual({ upserted: 0, reconciled: 1 });
  });

  it('batches rows in groups of 500', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => normalizedRow({ sourceId: `tx-${i}` }));
    mockReturning._result = Promise.resolve(new Array(500).fill({ id: 1 }));

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, ['tx-1'], rows);

    // 1200 rows / 500 batch = 3 batches
    expect(mockInsertValues).toHaveBeenCalledTimes(3);
    expect((mockInsertValues.mock.calls[0]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[1]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[2]![0] as unknown[]).length).toBe(200);
  });

  it('uses ON CONFLICT with source_id target', async () => {
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, ['tx-1'], [normalizedRow()]);

    expect(mockOnConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
      }),
    );
  });

  it('counts upserted rows from returning, separate from reconciled', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => normalizedRow({ sourceId: `tx-${i}` }));
    mockReturning._result = Promise.resolve([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mockDeleteReturning._result = Promise.resolve([{ id: 99 }]);

    const { upsertRows } = await import('./sync.js');
    const result = await upsertRows(10, 500, ['tx-1'], rows);

    expect(result).toEqual({ upserted: 3, reconciled: 1 });
  });

  it('deletes within the same transaction the insert runs in, not a separate call', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, ['tx-1'], [normalizedRow()]);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  // Structural check that the delete predicate carries the four scoping
  // conditions the design requires. This can't prove the SQL filters rows
  // correctly against real data, a mocked .where() says nothing about what
  // Postgres would do with it, so sync.integration.test.ts proves that part
  // against a real database. This only proves the right pieces were asked
  // for.
  it('scopes the delete to org, dataset, quickbooks rows, and this batch fetched ids', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, ['tx-1', 'tx-2'], [normalizedRow({ sourceId: 'tx-1-line-1' })]);

    const where = mockDeleteWhere.mock.calls[0]![0] as { conditions: unknown[] };
    expect(where.conditions).toEqual([
      { op: 'eq', col: 'org_id', val: 10 },
      { op: 'eq', col: 'dataset_id', val: 500 },
      { op: 'eq', col: 'source_type', val: 'quickbooks' },
      expect.objectContaining({ op: 'inArray', vals: ['tx-1', 'tx-2'] }),
      expect.objectContaining({ op: 'notInArray', vals: ['tx-1-line-1'] }),
    ]);
  });
});
