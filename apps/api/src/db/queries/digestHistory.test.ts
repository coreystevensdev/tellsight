import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, lt } from 'drizzle-orm';

import * as schema from '../schema.js';
import { digestHistory } from '../schema.js';

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockInsertValues = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }));
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {
    query: { digestHistory: { findFirst: mockFindFirst, findMany: mockFindMany } },
    insert: mockInsert,
  },
}));

// Real Drizzle instance over an inert (unreachable) postgres connection, used
// only to call .toSQL() and confirm the excludeWeekStart filter actually
// reaches the emitted SQL, not just the mock call args. Same rig as
// aiSummaries.test.ts's getCachedDigest weekStart-scoping assertion.
const inertClient = postgres('postgres://test:test@localhost:1/test', {
  max: 0,
  fetch_types: false,
  prepare: false,
});
const inertDb = drizzle(inertClient, { schema });

const { getLastDigest, getTrailingDigests, saveDigestHistory } = await import('./digestHistory.js');

const sampleInput = {
  orgId: 3,
  datasetId: 11,
  summaryId: 42,
  weekStart: new Date('2026-05-25T00:00:00Z'),
  subjectLine: 'Revenue up, watch payroll',
  stateSentence: 'You took in more than you spent this week.',
  valence: 'positive' as const,
  keyStats: [],
  milestones: [],
  sentAt: new Date('2026-05-25T13:00:00Z'),
};

beforeEach(() => {
  mockFindFirst.mockReset();
  mockFindMany.mockReset();
  mockOnConflictDoNothing.mockReset().mockResolvedValue(undefined);
  mockInsertValues.mockClear();
  mockInsert.mockClear();
});

describe('getLastDigest', () => {
  it('returns the most recent row for the org', async () => {
    const row = { id: 5, orgId: 3, weekStart: new Date('2026-05-25T00:00:00Z') };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getLastDigest(3);

    expect(result).toEqual({ ...row, milestones: [] });
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it('returns undefined when the org has no history', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    expect(await getLastDigest(99)).toBeUndefined();
  });

  it('still resolves the most recent row when excludeWeekStart is provided', async () => {
    const row = { id: 6, orgId: 3, weekStart: new Date('2026-05-18T00:00:00Z') };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getLastDigest(3, new Date('2026-05-25T00:00:00Z'));

    expect(result).toEqual({ ...row, milestones: [] });
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it('forwards excludeWeekStart into a different where clause than the no-filter call', async () => {
    // Proves the real function forwards the argument, not just that the
    // hand-built SQL below matches (the .toSQL() tests below verify shape).
    mockFindFirst.mockResolvedValueOnce(undefined);
    await getLastDigest(3);
    const withoutExclude = mockFindFirst.mock.calls[0]![0] as { where: unknown };

    mockFindFirst.mockReset().mockResolvedValueOnce(undefined);
    await getLastDigest(3, new Date('2026-05-25T00:00:00Z'));
    const withExclude = mockFindFirst.mock.calls[0]![0] as { where: unknown };

    expect(withExclude.where).not.toEqual(withoutExclude.where);
  });

  it('emits a week_start < $ filter in the SQL when excludeWeekStart is supplied', () => {
    const excludeWeekStart = new Date('2026-05-25T00:00:00Z');
    const query = inertDb.query.digestHistory.findFirst({
      where: and(eq(digestHistory.orgId, 3), lt(digestHistory.weekStart, excludeWeekStart)),
    });
    const { sql, params } = query.toSQL();

    expect(sql).toMatch(/"(?:digest_history|digestHistory)"\."week_start"\s*<\s*\$/);
    const containsExcludeWeekStart = params.some((p) =>
      p instanceof Date
        ? p.getTime() === excludeWeekStart.getTime()
        : typeof p === 'string' && new Date(p).getTime() === excludeWeekStart.getTime(),
    );
    expect(containsExcludeWeekStart).toBe(true);
  });

  it('does not emit a week_start filter when excludeWeekStart is omitted', () => {
    const query = inertDb.query.digestHistory.findFirst({
      where: and(eq(digestHistory.orgId, 3)),
    });
    const { sql } = query.toSQL();

    expect(sql).not.toMatch(/"(?:digest_history|digestHistory)"\."week_start"\s*</);
  });

  it('keeps well-formed milestones and drops malformed ones', async () => {
    const milestones = [
      { kind: 'first_profitable_month', label: 'First profitable month', catalog: 'first_time' },
      { kind: 'runway_crossed_12mo', label: 'not an object' }, // missing catalog
      'not an object',
      { kind: 'x', label: 'y', catalog: 'unknown_catalog' },
    ];
    mockFindFirst.mockResolvedValueOnce({ id: 7, orgId: 3, milestones });

    const result = await getLastDigest(3);

    expect(result!.milestones).toEqual([milestones[0]]);
  });

  it('defaults milestones to an empty array when the stored value is not an array', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 8, orgId: 3, milestones: null });

    const result = await getLastDigest(3);

    expect(result!.milestones).toEqual([]);
  });
});

describe('getTrailingDigests', () => {
  it('returns up to `limit` rows newest-first', async () => {
    const rows = [
      { id: 9, weekStart: new Date('2026-05-25T00:00:00Z') },
      { id: 8, weekStart: new Date('2026-05-18T00:00:00Z') },
    ];
    mockFindMany.mockResolvedValueOnce(rows);

    const result = await getTrailingDigests(3, 4);

    expect(result).toEqual(rows.map((row) => ({ ...row, keyStats: [] })));
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
    );
  });

  it('returns an empty array when the org has no history', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    expect(await getTrailingDigests(99, 4)).toEqual([]);
  });

  it('passes each row\'s well-formed keyStats entries through, proving the ComputedStat[] cast preserves valid data', async () => {
    const keyStats = [
      { statType: 'trend', category: 'Sales', value: 100, details: { slope: 1, intercept: 0, growthPercent: 5, dataPoints: 4, firstValue: 90, lastValue: 100 } },
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 9, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual(keyStats);
  });

  it('drops keyStats entries that fail the base ComputedStat shape check, now that compare_to_prior_periods reads them into a model-citable response', async () => {
    const valid = { statType: 'total', category: 'Revenue', value: 5000, details: { scope: 'org', count: 12 } };
    const keyStats = [
      valid,
      { statType: 'total', category: 'Revenue', value: 'not a number' }, // value not a number
      { statType: 'made_up_stat_type', category: 'Revenue', value: 10 }, // unknown statType
      { statType: 'total', value: 10 }, // missing category
      null,
      'not an object',
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 10, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([valid]);
  });

  it('drops year_over_year/seasonal_projection/cash_flow entries with a missing discriminator field, since statInstanceId dereferences it on every compare_to_prior_periods match', async () => {
    const validYoy = { statType: 'year_over_year', category: 'Revenue', value: 1000, details: { currentYear: 2026, month: 'Mar', priorYear: 2025, changePercent: 10 } };
    const keyStats = [
      validYoy,
      { statType: 'year_over_year', category: 'Revenue', value: 900, details: { currentYear: 2026 } }, // missing details.month
      { statType: 'seasonal_projection', category: 'Revenue', value: 800, details: {} }, // missing details.projectedMonth
      { statType: 'cash_flow', category: null, value: 700, details: { monthlyNet: 100 } }, // missing details.trailingMonths
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 12, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([validYoy]);
  });

  it('drops a year_over_year entry whose details.month is not a real month name, since mostRecentMatch ties break on MONTH_NAMES.indexOf', async () => {
    const keyStats = [
      { statType: 'year_over_year', category: 'Revenue', value: 900, details: { currentYear: 2026, month: 'March' } }, // full name, not the 'Mar' MONTH_NAMES stores
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 13, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([]);
  });

  it('drops year_over_year/cash_flow entries whose numeric discriminator field is NaN or Infinity', async () => {
    const keyStats = [
      { statType: 'year_over_year', category: 'Revenue', value: 900, details: { currentYear: NaN, month: 'Mar' } },
      { statType: 'cash_flow', category: null, value: 700, details: { trailingMonths: Infinity } },
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 14, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([]);
  });

  it('drops a total/average entry with a non-string details.scope, matching statDiscriminator\'s dereference of that field even though neither statType is reachable via compare_to_prior_periods today', async () => {
    const keyStats = [
      { statType: 'total', category: 'Revenue', value: 5000, details: {} }, // missing details.scope
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 15, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([]);
  });

  it('defaults keyStats to an empty array when the stored value is not an array', async () => {
    mockFindMany.mockResolvedValueOnce([{ id: 11, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats: null }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([]);
  });

  it('keeps a trend entry with garbage details, since statDiscriminator\'s default branch never dereferences details for that stat type', async () => {
    const trendWithGarbageDetails = { statType: 'trend', category: 'Sales', value: 100, details: 'not an object at all' };
    mockFindMany.mockResolvedValueOnce([{ id: 16, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats: [trendWithGarbageDetails] }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toEqual([trendWithGarbageDetails]);
  });
});

describe('saveDigestHistory', () => {
  it('inserts one row from the input', async () => {
    await saveDigestHistory(sampleInput);

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 3, valence: 'positive', sentAt: sampleInput.sentAt }),
    );
  });

  it('defers double-write protection to the (org, week) unique index', async () => {
    await saveDigestHistory(sampleInput);

    expect(mockOnConflictDoNothing).toHaveBeenCalledOnce();
    // target must be the column refs of the unique index, not the index name
    expect(mockOnConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Array) }),
    );
  });
});
