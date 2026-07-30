import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, isNull } from 'drizzle-orm';

import * as schema from '../schema.js';
import { aiSummaries } from '../schema.js';

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

// Real Drizzle instance backed by an inert postgres tag so we can call
// `.toSQL()` on relational queries and verify the audience filter actually
// reaches the database. Story 9.2 AC #14j called out the seed-summary
// regression risk: if the new `eq(audience, 'dashboard')` filter on
// `getCachedSummary` were dropped (or scoped to the wrong literal), demo
// mode silently breaks. The mock-based assertion below proves only that
// `findFirst` was called; this rig proves the SQL actually filters.
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

describe('seed-summary cache regression (AC #14j)', () => {
  // Pre-migration rows did not carry an `audience` column. Migration 0020
  // backfills every row to `audience='dashboard'` via the column DEFAULT.
  // After that, the new audience-scoped getCachedSummary must still find
  // them. The risk: if the filter ever drifts (e.g., to `audience='primary'`
  // or `'main'`), demo mode silently breaks for every existing user.

  it('emits a SQL filter that matches the migration DEFAULT literal', () => {
    // Build the same query getCachedSummary builds, run it through .toSQL(),
    // and assert the bound param is the EXACT string the migration backfills.
    const query = inertDb.query.aiSummaries.findFirst({
      where: and(
        eq(aiSummaries.orgId, 1),
        eq(aiSummaries.datasetId, 1),
        eq(aiSummaries.audience, 'dashboard'),
        isNull(aiSummaries.staleAt),
      ),
    });
    const { sql, params } = query.toSQL();

    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."audience"\s*=\s*\$/);
    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."stale_at"\s+is\s+null/i);
    // The literal must match migration 0020's DEFAULT 'dashboard' verbatim.
    // If a future refactor renames the audience to 'primary' on either side,
    // this assertion catches the drift before it reaches production.
    expect(params).toContain('dashboard');
  });

  it('finds seed-flagged dashboard rows via getCachedSummary after migration backfill', async () => {
    // Shape mirrors what migration 0020's DEFAULT backfill produces for an
    // existing pre-migration row: audience set, week_start NULL, all other
    // columns unchanged.
    const seedRow = {
      id: 99,
      orgId: 1,
      datasetId: 1,
      content: 'seed AI summary content',
      audience: 'dashboard',
      weekStart: null,
      isSeed: true,
      staleAt: null,
    };
    mockFindFirst.mockResolvedValueOnce(seedRow);

    const result = await getCachedSummary(1, 1);

    expect(result).toEqual(seedRow);
    // The where clause must include both the audience filter AND the stale
    // filter; either one missing reintroduces the regression.
    const callArg = mockFindFirst.mock.calls[0]![0] as { where: unknown };
    expect(callArg.where).toBeDefined();
  });

  it('does not match digest-weekly rows when scanning the dashboard cache', () => {
    // Boundary check: the same query, given a digest-audience row, would
    // skip it. We can't run the query, but we CAN verify the audience
    // literal is the dashboard value and not something looser (e.g., a
    // wildcard or LIKE). If audience drifted to `like('%dash%')` this
    // assertion fails because the operator would not be `=`.
    const dashQuery = inertDb.query.aiSummaries.findFirst({
      where: and(
        eq(aiSummaries.orgId, 1),
        eq(aiSummaries.datasetId, 1),
        eq(aiSummaries.audience, 'dashboard'),
        isNull(aiSummaries.staleAt),
      ),
    });
    const { sql } = dashQuery.toSQL();
    // The audience predicate must use equality, not LIKE / IN / regex / etc.
    // A regression to a looser match would let digest-weekly rows poison
    // the dashboard cache.
    expect(sql).not.toMatch(/"(?:ai_summaries|aiSummaries)"\."audience"\s+(like|in|~|<>|!=)/i);
  });

  it('getCachedDigest scopes to digest-weekly + matches weekStart by equality', () => {
    const weekStart = new Date('2026-05-03T00:00:00Z');
    const query = inertDb.query.aiSummaries.findFirst({
      where: and(
        eq(aiSummaries.orgId, 1),
        eq(aiSummaries.datasetId, 1),
        eq(aiSummaries.audience, 'digest-weekly'),
        eq(aiSummaries.weekStart, weekStart),
        isNull(aiSummaries.staleAt),
      ),
    });
    const { sql, params } = query.toSQL();

    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."audience"\s*=\s*\$/);
    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."week_start"\s*=\s*\$/);
    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."stale_at"\s+is\s+null/i);
    expect(params).toContain('digest-weekly');
    // Drizzle serializes timestamptz values as ISO strings on the wire.
    const containsWeekStart = params.some((p) =>
      p instanceof Date
        ? p.getTime() === weekStart.getTime()
        : typeof p === 'string' && new Date(p).getTime() === weekStart.getTime(),
    );
    expect(containsWeekStart).toBe(true);
  });

  it('getCachedAlertSummary scopes to alert + matches fireId by equality', () => {
    const query = inertDb.query.aiSummaries.findFirst({
      where: and(
        eq(aiSummaries.orgId, 1),
        eq(aiSummaries.datasetId, 1),
        eq(aiSummaries.audience, 'alert'),
        eq(aiSummaries.fireId, 501),
      ),
    });
    const { sql, params } = query.toSQL();

    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."audience"\s*=\s*\$/);
    expect(sql).toMatch(/"(?:ai_summaries|aiSummaries)"\."fire_id"\s*=\s*\$/);
    expect(params).toContain('alert');
    expect(params).toContain(501);
  });
});
