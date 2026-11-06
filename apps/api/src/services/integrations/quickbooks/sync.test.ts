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
const mockLoggerWarn = vi.fn();

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
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
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

import type { NormalizedQbRow, QbTransaction } from './types.js';

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

  it('skips a transaction with no usable Id and still reconciles the valid ones', async () => {
    // The exact shape the probe proved fatal: one malformed transaction
    // mixed among valid ones rendered metadata->>'qb_id' in (, $5), a SQL
    // syntax error that rolled back every chunk already committed for
    // this entity type. Dropping it before it reaches upsertRows is what
    // keeps the two valid invoices reconciling at all.
    mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
    const noId = { TxnDate: '2026-04-10' } as unknown as QbTransaction;
    const client = mockQbClient({
      query: vi
        .fn()
        .mockImplementation((entityType: string) =>
          Promise.resolve(
            entityType === 'Invoice'
              ? [
                  { Id: 'inv-good-1', TxnDate: '2026-04-10' },
                  noId,
                  { Id: 'inv-good-2', TxnDate: '2026-04-10' },
                ]
              : [],
          ),
        ),
    });
    mockCreateQbClient.mockResolvedValueOnce(client);
    mockGetDatasetsByOrg.mockResolvedValueOnce([]);
    mockCreateDataset.mockResolvedValueOnce({ id: 500 });
    mockNormalizeTransactions.mockReturnValue([normalizedRow()]);
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { runSync } = await import('./sync.js');
    await expect(runSync(1, 'initial')).resolves.not.toThrow();

    expect(mockNormalizeTransactions).toHaveBeenCalledWith(
      [
        { Id: 'inv-good-1', TxnDate: '2026-04-10' },
        { Id: 'inv-good-2', TxnDate: '2026-04-10' },
      ],
      'Invoice',
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { orgId: 10, entityType: 'Invoice', dropped: 1 },
      'QB transaction missing a usable Id, skipped',
    );

    // The real upsertRows ran against only the two valid ids, the thing
    // that threw against real Postgres when the bad one was included.
    const deleteWhere = mockDeleteWhere.mock.calls.find((call) => {
      const where = call[0] as { conditions: unknown[] };
      return where.conditions.some(
        (c) => typeof c === 'object' && c !== null && (c as { op?: string }).op === 'inArray',
      );
    });
    const where = deleteWhere![0] as { conditions: unknown[] };
    const inArrayCond = where.conditions.find(
      (c): c is { vals: unknown[] } =>
        typeof c === 'object' && c !== null && (c as { op?: string }).op === 'inArray',
    );
    expect(inArrayCond?.vals).toEqual(['inv-good-1', 'inv-good-2']);
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
    const result = await upsertRows(10, 500, 'Purchase', [], []);
    expect(result).toEqual({ upserted: 0, reconciled: 0 });
  });

  it('skips the delete and insert entirely when nothing was fetched', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', [], []);

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
    const result = await upsertRows(10, 500, 'Purchase', ['tx-now-empty'], []);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(result).toEqual({ upserted: 0, reconciled: 1 });
  });

  it('deduplicates fetchedTxnIds before building the delete', async () => {
    // STARTPOSITION pagination over data that changes mid-page can hand
    // back the same transaction twice. A literal duplicate would otherwise
    // count twice toward the chunk budget and could straddle two chunks,
    // breaking the assumption that chunks partition the id space.
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', ['tx-1', 'tx-1', 'tx-2'], []);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    const where = mockDeleteWhere.mock.calls[0]![0] as { conditions: unknown[] };
    const inArrayCond = where.conditions.find(
      (c): c is { vals: unknown[] } =>
        typeof c === 'object' && c !== null && (c as { op?: string }).op === 'inArray',
    );
    expect(inArrayCond?.vals).toEqual(['tx-1', 'tx-2']);
  });

  it('chunks the delete when fetchedTxnIds exceeds the batch size', async () => {
    const fetchedTxnIds = Array.from({ length: 1200 }, (_, i) => `tx-${i}`);

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', fetchedTxnIds, []);

    // 1200 ids / 500 batch = 3 delete statements, matching the insert side's
    // existing chunking rather than one statement with 1200 bind params.
    expect(mockDeleteWhere).toHaveBeenCalledTimes(3);
    const chunkSizes = mockDeleteWhere.mock.calls.map((call) => {
      const where = call[0] as { conditions: unknown[] };
      const inArrayCond = where.conditions.find(
        (c): c is { vals: unknown[] } =>
          typeof c === 'object' && c !== null && (c as { op?: string }).op === 'inArray',
      );
      return inArrayCond?.vals.length;
    });
    expect(chunkSizes).toEqual([500, 500, 200]);
  });

  it("subsets the produced source ids to each chunk's own transactions, not the full set", async () => {
    // The conservative-but-still-broken variant chunks only the fetched-id
    // list and leaves the full produced set on every statement, which still
    // blows the parameter ceiling at scale. Each chunk's NOT IN list must
    // only ever name rows whose qb_id is one of that chunk's own ids.
    const fetchedTxnIds = Array.from({ length: 501 }, (_, i) => `tx-${i}`);
    const rows = [
      normalizedRow({
        sourceId: 'tx-500-0',
        metadata: {
          qb_id: 'tx-500',
          txnType: 'Purchase',
          docNumber: null,
          memo: null,
          accountCode: null,
        },
      }),
    ];

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', fetchedTxnIds, rows);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(2);
    const notInArrayValsByChunk = mockDeleteWhere.mock.calls.map((call) => {
      const where = call[0] as { conditions: unknown[] };
      const notInArrayCond = where.conditions.find(
        (c): c is { vals: unknown[] } =>
          typeof c === 'object' && c !== null && (c as { op?: string }).op === 'notInArray',
      );
      return notInArrayCond?.vals;
    });

    expect(notInArrayValsByChunk[0]).toEqual([]);
    expect(notInArrayValsByChunk[1]).toEqual(['tx-500-0']);
  });

  it('never lets a single delete chunk exceed its budget regardless of lines per transaction', async () => {
    // The exact measured failure: 500 ids averaging 131 produced rows each
    // is 66,004 total bind parameters against postgres.js's 65,533 ceiling
    // (500 at 130 each succeeds at 65,504). Chunking by accumulated
    // produced-row count, not just id count, means no chunk can reach
    // either limit regardless of how many lines a transaction has.
    const fetchedTxnIds = Array.from({ length: 500 }, (_, i) => `tx-${i}`);
    const rows = fetchedTxnIds.flatMap((id) =>
      Array.from({ length: 131 }, (_, lineIndex) =>
        normalizedRow({
          sourceId: `${id}-${lineIndex}`,
          metadata: {
            qb_id: id,
            txnType: 'Invoice',
            docNumber: null,
            memo: null,
            accountCode: null,
          },
        }),
      ),
    );

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Invoice', fetchedTxnIds, rows);

    let totalNotInArrayVals = 0;
    for (const call of mockDeleteWhere.mock.calls) {
      const where = call[0] as { conditions: unknown[] };
      const inArrayCond = where.conditions.find(
        (c): c is { vals: unknown[] } =>
          typeof c === 'object' && c !== null && (c as { op?: string }).op === 'inArray',
      );
      const notInArrayCond = where.conditions.find(
        (c): c is { vals: unknown[] } =>
          typeof c === 'object' && c !== null && (c as { op?: string }).op === 'notInArray',
      );

      expect(inArrayCond?.vals.length ?? 0).toBeLessThanOrEqual(500);
      expect(notInArrayCond?.vals.length ?? 0).toBeLessThanOrEqual(500);
      totalNotInArrayVals += notInArrayCond?.vals.length ?? 0;
    }

    // Every produced row has to land in exactly one chunk's NOT IN list;
    // this is what rules out a transaction getting split across chunks or
    // a row being dropped or double-counted along the way.
    expect(totalNotInArrayVals).toBe(rows.length);
  });

  it('deduplicates rows by sourceId before inserting or counting toward the delete budget', async () => {
    // STARTPOSITION pagination returning the same transaction twice
    // duplicates its rows in this array too, not just its id in
    // fetchedTxnIds. An undeduplicated pair here would insert the same
    // sourceId twice in one statement, which postgres rejects with "ON
    // CONFLICT DO UPDATE command cannot affect row a second time", and
    // would count the transaction's rows twice toward the chunk budget.
    const first = normalizedRow({ sourceId: 'tx-1-line-1', amount: '100' });
    const second = normalizedRow({ sourceId: 'tx-1-line-1', amount: '200' });
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', ['tx-1'], [first, second]);

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    const insertedValues = mockInsertValues.mock.calls[0]![0] as Array<{ amount: string }>;
    expect(insertedValues).toHaveLength(1);
    // The later occurrence wins, reflecting whatever changed between the
    // two fetches on its second appearance.
    expect(insertedValues[0]!.amount).toBe('200');
  });

  it('batches rows in groups of 500', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => normalizedRow({ sourceId: `tx-${i}` }));
    mockReturning._result = Promise.resolve(new Array(500).fill({ id: 1 }));

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', ['tx-1'], rows);

    // 1200 rows / 500 batch = 3 batches
    expect(mockInsertValues).toHaveBeenCalledTimes(3);
    expect((mockInsertValues.mock.calls[0]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[1]![0] as unknown[]).length).toBe(500);
    expect((mockInsertValues.mock.calls[2]![0] as unknown[]).length).toBe(200);
  });

  it('uses ON CONFLICT with source_id target', async () => {
    mockReturning._result = Promise.resolve([{ id: 1 }]);

    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', ['tx-1'], [normalizedRow()]);

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
    const result = await upsertRows(10, 500, 'Purchase', ['tx-1'], rows);

    expect(result).toEqual({ upserted: 3, reconciled: 1 });
  });

  it('deletes within the same transaction the insert runs in, not a separate call', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(10, 500, 'Purchase', ['tx-1'], [normalizedRow()]);

    expect(mockDeleteWhere).toHaveBeenCalledTimes(1);
    expect(mockInsertValues).toHaveBeenCalledTimes(1);
  });

  // Structural check that the delete predicate carries the five scoping
  // conditions the design requires. This can't prove the SQL filters rows
  // correctly against real data, a mocked .where() says nothing about what
  // Postgres would do with it, so sync.integration.test.ts proves that part
  // against a real database. This only proves the right pieces were asked
  // for.
  it('scopes the delete to org, dataset, quickbooks rows, this entity type, and this batch fetched ids', async () => {
    const { upsertRows } = await import('./sync.js');
    await upsertRows(
      10,
      500,
      'Invoice',
      ['tx-1', 'tx-2'],
      [normalizedRow({ sourceId: 'tx-1-line-1' })],
    );

    const where = mockDeleteWhere.mock.calls[0]![0] as { conditions: unknown[] };
    expect(where.conditions).toEqual([
      { op: 'eq', col: 'org_id', val: 10 },
      { op: 'eq', col: 'dataset_id', val: 500 },
      { op: 'eq', col: 'source_type', val: 'quickbooks' },
      { op: 'eq', col: expect.anything(), val: 'Invoice' },
      expect.objectContaining({ op: 'inArray', vals: ['tx-1', 'tx-2'] }),
      expect.objectContaining({ op: 'notInArray', vals: ['tx-1-line-1'] }),
    ]);
  });
});
