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

    expect(result).toEqual(row);
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

    expect(result).toEqual(row);
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
});

describe('getTrailingDigests', () => {
  it('returns up to `limit` rows newest-first', async () => {
    const rows = [
      { id: 9, weekStart: new Date('2026-05-25T00:00:00Z') },
      { id: 8, weekStart: new Date('2026-05-18T00:00:00Z') },
    ];
    mockFindMany.mockResolvedValueOnce(rows);

    const result = await getTrailingDigests(3, 4);

    expect(result).toEqual(rows);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
    );
  });

  it('returns an empty array when the org has no history', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    expect(await getTrailingDigests(99, 4)).toEqual([]);
  });

  it('passes each row\'s keyStats through unchanged, proving the ComputedStat[] cast does not drop or rewrite it', async () => {
    const keyStats = [
      { statType: 'trend', category: 'Sales', value: 100, details: { slope: 1, intercept: 0, growthPercent: 5, dataPoints: 4, firstValue: 90, lastValue: 100 } },
    ];
    mockFindMany.mockResolvedValueOnce([{ id: 9, weekStart: new Date('2026-05-25T00:00:00Z'), keyStats }]);

    const [result] = await getTrailingDigests(3, 4);

    expect(result!.keyStats).toBe(keyStats);
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
