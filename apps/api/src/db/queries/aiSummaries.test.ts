import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { SQL } from 'drizzle-orm';

import * as schema from '../schema.js';

const mockFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockInsertValues = vi.fn(() => ({ returning: mockReturning }));

vi.mock('../../lib/db.js', () => ({
  db: {
    query: { aiSummaries: { findFirst: mockFindFirst } },
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(),
  },
}));

// Real Drizzle instance over an inert postgres tag, so a captured where clause
// can be rendered with .toSQL() without a database behind it. Only the
// predicate is built here; nothing connects.
const inertClient = postgres('postgres://test:test@localhost:1/test', {
  max: 0,
  fetch_types: false,
  prepare: false,
});
const inertDb = drizzle(inertClient, { schema });

const { getCachedSummary, getCachedDigest, getCachedAlertSummary, getLatestSummary, storeSummary } =
  await import('./aiSummaries.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCachedSummary', () => {
  it('returns the cached row when present', async () => {
    const row = { id: 1, orgId: 7, datasetId: 9, audience: 'dashboard' };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getCachedSummary(7, 9);

    expect(result).toEqual(row);
    expect(mockFindFirst).toHaveBeenCalledWith({ where: expect.anything() });
  });

  it('passes a custom client through (transactional reads)', async () => {
    const txQuery = { aiSummaries: { findFirst: vi.fn().mockResolvedValueOnce(undefined) } };
    const tx = { query: txQuery } as never;

    await getCachedSummary(7, 9, tx);

    expect(txQuery.aiSummaries.findFirst).toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe('getCachedDigest', () => {
  it('reads with weekStart pinned to the requested week', async () => {
    const weekStart = new Date('2026-05-03T00:00:00Z');
    const row = { id: 1, orgId: 7, datasetId: 9, audience: 'digest-weekly', weekStart };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getCachedDigest(7, 9, weekStart);

    expect(result).toEqual(row);
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it('returns undefined on cache miss', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const result = await getCachedDigest(7, 9, new Date('2026-05-03T00:00:00Z'));

    expect(result).toBeUndefined();
  });
});

describe('getCachedAlertSummary', () => {
  it('reads with fireId pinned to the requested fire', async () => {
    const row = { id: 1, orgId: 7, datasetId: 9, audience: 'alert', fireId: 501 };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getCachedAlertSummary(7, 9, 501);

    expect(result).toEqual(row);
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it('returns undefined on cache miss', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    const result = await getCachedAlertSummary(7, 9, 501);

    expect(result).toBeUndefined();
  });
});

describe('getLatestSummary', () => {
  it('returns the most recent dashboard row regardless of staleness', async () => {
    const row = { id: 1, audience: 'dashboard', staleAt: new Date() };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getLatestSummary(7, 9);

    expect(result).toEqual(row);
  });
});

describe('storeSummary (options bag)', () => {
  it('writes with dashboard defaults', async () => {
    const inserted = { id: 1 };
    mockReturning.mockResolvedValueOnce([inserted]);

    await storeSummary({
      orgId: 7,
      datasetId: 9,
      content: 'fresh insights',
      metadata: { promptVersion: 'v1.6' },
      promptVersion: 'v1.6',
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 7,
        datasetId: 9,
        content: 'fresh insights',
        promptVersion: 'v1.6',
        isSeed: false,
        audience: 'dashboard',
        weekStart: null,
      }),
    );
  });

  it('writes a digest row with audience + weekStart', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 2 }]);
    const weekStart = new Date('2026-05-03T00:00:00Z');

    await storeSummary({
      orgId: 7,
      datasetId: 9,
      content: '- bullet 1\n- bullet 2',
      metadata: { promptVersion: 'v1-digest' },
      promptVersion: 'v1-digest',
      audience: 'digest-weekly',
      weekStart,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'digest-weekly',
        weekStart,
      }),
    );
  });

  it('writes an alert row with audience + fireId', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5 }]);

    await storeSummary({
      orgId: 7,
      datasetId: 9,
      content: 'Your runway is now 2.5 months.',
      metadata: { promptVersion: 'v1-alert' },
      promptVersion: 'v1-alert',
      audience: 'alert',
      fireId: 501,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'alert', fireId: 501, weekStart: null }),
    );
  });

  it('honors isSeed=true for seed-generated rows', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 3 }]);

    await storeSummary({
      orgId: 7,
      datasetId: 9,
      content: 'seed summary',
      metadata: {},
      promptVersion: 'v1.6',
      isSeed: true,
    });

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ isSeed: true, audience: 'dashboard' }),
    );
  });

  it('routes through a custom client when one is supplied', async () => {
    const txReturning = vi.fn().mockResolvedValueOnce([{ id: 4 }]);
    const txValues = vi.fn(() => ({ returning: txReturning }));
    const tx = { insert: vi.fn(() => ({ values: txValues })) } as never;

    await storeSummary({
      orgId: 7,
      datasetId: 9,
      content: 'tx write',
      metadata: {},
      promptVersion: 'v1.6',
      client: tx,
    });

    expect(txValues).toHaveBeenCalled();
    expect(mockInsertValues).not.toHaveBeenCalled();
  });
});

// Renders the clause a helper actually built, rather than one written here. An
// earlier version of this block rebuilt each where clause inline and asserted on
// its own construction, which is a statement about Drizzle and not about these
// functions: dropping the org filter from getCachedSummary left all 2,470 API
// tests green.
async function emitted(run: () => Promise<unknown>) {
  mockFindFirst.mockResolvedValueOnce(undefined);
  await run();
  const arg = mockFindFirst.mock.calls.at(-1)![0] as { where: SQL; orderBy?: SQL[] };
  return inertDb.query.aiSummaries.findFirst(arg).toSQL();
}

// Anchored on the table alias so a bare column in the select list cannot satisfy it.
const filtersOn = (column: string) => new RegExp(`"aiSummaries"\\."${column}"\\s*=\\s*\\$`);
const excludesStale = /"aiSummaries"\."stale_at"\s+is\s+null/i;

describe('the SQL the cache lookups emit', () => {
  // Migration 0020 backfilled every pre-existing row to audience='dashboard' via
  // the column DEFAULT. If either side of that drifts, demo mode goes blank for
  // every account older than the migration.
  it('getCachedSummary scopes to org, dataset, dashboard and fresh', async () => {
    const { sql, params } = await emitted(() => getCachedSummary(7, 9));

    expect(sql).toMatch(filtersOn('org_id'));
    expect(sql).toMatch(filtersOn('dataset_id'));
    expect(sql).toMatch(excludesStale);
    // slice rather than arrayContaining: the latter is order-blind, so swapping
    // the org and dataset predicates in the source still satisfied it.
    expect(params.slice(0, 2)).toEqual([7, 9]);
    expect(params).toContain('dashboard');
  });

  it('getCachedDigest pins the week and still excludes stale rows', async () => {
    const weekStart = new Date('2026-05-03T00:00:00Z');
    const { sql, params } = await emitted(() => getCachedDigest(7, 9, weekStart));

    expect(sql).toMatch(filtersOn('org_id'));
    expect(sql).toMatch(filtersOn('week_start'));
    expect(sql).toMatch(excludesStale);
    expect(params.slice(0, 2)).toEqual([7, 9]);
    expect(params).toContain('digest-weekly');
    // timestamptz crosses the wire as an ISO string, so compare instants.
    expect(
      params.some((p) => typeof p === 'string' && new Date(p).getTime() === weekStart.getTime()),
    ).toBe(true);
  });

  // Alerts fire once per event rather than once per week, so cache identity is
  // the fire and not the calendar.
  it('getCachedAlertSummary keys on fireId and not weekStart', async () => {
    const { sql, params } = await emitted(() => getCachedAlertSummary(7, 9, 501));

    expect(sql).toMatch(filtersOn('org_id'));
    expect(sql).toMatch(filtersOn('fire_id'));
    expect(sql).not.toMatch(filtersOn('week_start'));
    expect(params.slice(0, 2)).toEqual([7, 9]);
    expect(params).toContain('alert');
    expect(params).toContain(501);
  });

  // This one returns stale rows deliberately. It feeds the "data updated,
  // refresh?" banner, which never appears if staleness is filtered out.
  it('getLatestSummary reads stale rows and orders by recency', async () => {
    const { sql, params } = await emitted(() => getLatestSummary(7, 9));

    expect(sql).toMatch(filtersOn('org_id'));
    expect(sql).not.toMatch(excludesStale);
    expect(sql).toMatch(/order by "aiSummaries"\."created_at" desc/i);
    expect(params.slice(0, 2)).toEqual([7, 9]);
    expect(params).toContain('dashboard');
  });
});
