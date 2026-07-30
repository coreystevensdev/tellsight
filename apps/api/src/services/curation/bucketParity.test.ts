import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { bucketRowsByMonth } from './computation.js';

let resolvedRows: Array<{ bucket: string; parentCategory: string | null; total: string }> = [];

function chain(): Record<string, ReturnType<typeof vi.fn>> {
  const c: Record<string, ReturnType<typeof vi.fn>> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.groupBy = vi.fn().mockImplementation(() => Promise.resolve(resolvedRows));
  return c;
}

vi.mock('../../lib/db.js', () => ({
  db: { select: vi.fn(() => chain()) },
}));

const { getMonthlyBucketsByDataset } = await import('../../db/queries/dataRows.js');

let _rowId = 90_000;

function row(parentCategory: string | null, year: number, month: number, day: number, amount: string) {
  return {
    id: _rowId++,
    orgId: 1,
    datasetId: 1,
    sourceType: 'csv' as const,
    category: parentCategory === 'Income' ? 'Revenue' : parentCategory === 'Expenses' ? 'COGS' : 'Transfers',
    parentCategory,
    date: new Date(Date.UTC(year, month - 1, day)),
    amount,
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

// Integer-cents accumulation, not a running float +=, mirrors what a
// numeric(12,2) column actually sums (bucketRowsByMonth uses float += on the
// same inputs, which is where the epsilon test below gets its real drift).
function sumDecimal(amounts: string[]): string {
  let cents = 0;
  for (const raw of amounts) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'NaN';
    cents += Math.round(n * 100);
  }
  return (cents / 100).toFixed(2);
}

// Independent of bucketRowsByMonth on purpose, if this called into the
// in-memory reducer instead, the parity test would only prove the mock
// agrees with itself.
function sqlLikeBuckets(rows: ReturnType<typeof row>[]) {
  const grouped = new Map<string, Map<string, string[]>>();
  for (const r of rows) {
    const bucket = `${r.date.getUTCFullYear()}-${String(r.date.getUTCMonth() + 1).padStart(2, '0')}`;
    const byCategory = grouped.get(bucket) ?? new Map<string, string[]>();
    const key = r.parentCategory ?? '';
    const amounts = byCategory.get(key) ?? [];
    amounts.push(r.amount);
    byCategory.set(key, amounts);
    grouped.set(bucket, byCategory);
  }

  const result: Array<{ bucket: string; parentCategory: string | null; total: string }> = [];
  for (const [bucket, byCategory] of grouped) {
    for (const [key, amounts] of byCategory) {
      result.push({ bucket, parentCategory: key === '' ? null : key, total: sumDecimal(amounts) });
    }
  }
  return result;
}

async function bothPaths(rows: ReturnType<typeof row>[]) {
  resolvedRows = sqlLikeBuckets(rows);
  const sql = await getMonthlyBucketsByDataset(1, 1);
  const inMemory = bucketRowsByMonth(rows);
  return { inMemory, sql };
}

describe('SQL vs in-memory monthly bucket parity', () => {
  let originalTz: string | undefined;

  beforeEach(() => {
    originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('agrees on multi-month, multi-category revenue and expenses', async () => {
    const rows = [
      row('Income', 2025, 1, 15, '10000.00'),
      row('Expenses', 2025, 1, 15, '6000.00'),
      row('Income', 2025, 2, 15, '12000.00'),
      row('Expenses', 2025, 2, 15, '7000.00'),
      row('Expenses', 2025, 2, 20, '500.00'),
    ];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.get('2025-01')).toEqual({ revenue: 10_000, expenses: 6_000 });
    expect(inMemory.get('2025-02')).toEqual({ revenue: 12_000, expenses: 7_500 });
  });

  it('buckets a day-1-of-month row under the same UTC month on both paths', async () => {
    // 2025-02-01T00:00:00Z is 2025-01-31T19:00 under America/New_York, the
    // exact case monthKey's old local-getter bug shifted into the wrong month.
    const rows = [row('Income', 2025, 2, 1, '5000.00')];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.has('2025-01')).toBe(false);
    expect(inMemory.get('2025-02')).toEqual({ revenue: 5000, expenses: 0 });
  });

  it('buckets a January 1st row under the new year on both paths across a year boundary', async () => {
    // 2026-01-01T00:00:00Z is 2025-12-31T19:00 under America/New_York, the same
    // local-getter bug also rolls the year back, not just the month.
    const rows = [row('Income', 2026, 1, 1, '3000.00')];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.has('2025-12')).toBe(false);
    expect(inMemory.get('2026-01')).toEqual({ revenue: 3000, expenses: 0 });
  });

  it('creates a bucket for a non-Income/Expenses parentCategory without adding to revenue or expenses', async () => {
    const rows = [row('Transfers', 2025, 3, 15, '1200.00')];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.get('2025-03')).toEqual({ revenue: 0, expenses: 0 });
  });

  it('creates a bucket for a null parentCategory without adding to revenue or expenses', async () => {
    const rows = [row(null, 2025, 3, 20, '800.00')];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.get('2025-03')).toEqual({ revenue: 0, expenses: 0 });
  });

  it('returns no buckets for an empty row set on both paths', async () => {
    const { inMemory, sql } = await bothPaths([]);

    expect(inMemory).toEqual(sql);
    expect(inMemory.size).toBe(0);
  });

  it('skips an unparseable amount on both paths', async () => {
    const rows = [
      row('Income', 2025, 4, 15, '2000.00'),
      row('Expenses', 2025, 4, 15, 'not-a-number'),
    ];

    const { inMemory, sql } = await bothPaths(rows);

    expect(inMemory).toEqual(sql);
    expect(inMemory.get('2025-04')).toEqual({ revenue: 2000, expenses: 0 });
  });

  it('agrees within float-rounding epsilon where JS float summation drifts from exact decimal sum', async () => {
    const rows = [
      row('Income', 2025, 5, 15, '0.10'),
      row('Income', 2025, 5, 16, '0.20'),
    ];

    const { inMemory, sql } = await bothPaths(rows);
    const inMemoryRevenue = inMemory.get('2025-05')!.revenue;
    const sqlRevenue = sql.get('2025-05')!.revenue;

    expect(inMemoryRevenue).toBeCloseTo(0.3, 6);
    expect(sqlRevenue).toBeCloseTo(0.3, 6);
    // 0.1 + 0.2 as a running float sum isn't bit-exact 0.3; a NUMERIC(12,2)
    // column's sum is. Confirms this test exercises the real drift, not two
    // accumulators that happen to agree.
    expect(inMemoryRevenue).not.toBe(sqlRevenue);
  });
});
