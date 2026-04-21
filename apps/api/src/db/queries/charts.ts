import { eq, and, sql, gte, lte, type SQL } from 'drizzle-orm';
import type { ChartFilters, Granularity } from 'shared/types';
import { db, type DbTransaction } from '../../lib/db.js';
import { dataRows } from '../schema.js';

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function bucketLabel(key: string, granularity: Granularity): string {
  if (granularity === 'weekly') {
    const parts = key.split('-');
    const monthIdx = parseInt(parts[1]!, 10) - 1;
    return `${MONTH_LABELS[monthIdx]} ${parseInt(parts[2]!, 10)}`;
  }
  const [year, month] = key.split('-');
  const monthIdx = parseInt(month!, 10) - 1;
  return `${MONTH_LABELS[monthIdx]} ${year}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bucketSql(granularity: Granularity) {
  if (granularity === 'weekly') {
    return sql<string>`to_char(date_trunc('week', ${dataRows.date}), 'YYYY-MM-DD')`;
  }
  return sql<string>`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`;
}

function scopeConditions(orgId: number, datasetId?: number): SQL[] {
  const conds: SQL[] = [eq(dataRows.orgId, orgId)];
  if (datasetId !== undefined) conds.push(eq(dataRows.datasetId, datasetId));
  return conds;
}

/**
 * Aggregates data_rows into chart-ready structures using SQL aggregation.
 *
 * Two queries:
 * 1. Metadata (unfiltered) — distinct expense categories + date range
 * 2. Aggregated buckets (filtered) — SUM(amount) grouped by time bucket + category
 *
 * Returns ~50-200 rows from the DB instead of 2,000 individual data_rows.
 */
export async function getChartData(
  orgId: number,
  filters?: ChartFilters,
  _limit?: number,
  client: typeof db | DbTransaction = db,
  datasetId?: number,
) {
  const granularity: Granularity = filters?.granularity ?? 'monthly';
  const scope = scopeConditions(orgId, datasetId);
  const bucket = bucketSql(granularity);

  const [metaRows, aggRows] = await Promise.all([
    client
      .select({
        minDate: sql<string>`min(${dataRows.date})::text`,
        maxDate: sql<string>`max(${dataRows.date})::text`,
      })
      .from(dataRows)
      .where(and(...scope)),

    (() => {
      const conds = [...scope];
      if (filters?.dateFrom) conds.push(gte(dataRows.date, filters.dateFrom));
      if (filters?.dateTo) conds.push(lte(dataRows.date, filters.dateTo));

      return client
        .select({
          bucket: bucket.as('bucket'),
          parentCategory: dataRows.parentCategory,
          category: dataRows.category,
          total: sql<string>`sum(${dataRows.amount})`.as('total'),
          year: sql<number>`extract(year from ${dataRows.date})::int`.as('year'),
          monthIdx: sql<number>`extract(month from ${dataRows.date})::int - 1`.as('month_idx'),
        })
        .from(dataRows)
        .where(and(...conds))
        .groupBy(
          bucket,
          dataRows.parentCategory,
          dataRows.category,
          sql`extract(year from ${dataRows.date})`,
          sql`extract(month from ${dataRows.date})`,
        )
        .orderBy(bucket);
    })(),
  ]);

  // -- metadata (unfiltered) --
  const meta = metaRows[0];
  const dateRange = meta?.minDate && meta?.maxDate
    ? { min: meta.minDate, max: meta.maxDate }
    : null;

  // categories come from the aggregated rows (all expense categories present in data)
  // but we need unfiltered categories for the filter dropdown. If date filters are active,
  // a category might be absent from aggRows. We'll collect from a quick distinct query only
  // when filters could hide categories.
  let availableCategories: string[];
  if (filters?.dateFrom || filters?.dateTo) {
    const catRows = await client
      .selectDistinct({ category: dataRows.category })
      .from(dataRows)
      .where(and(...scope, eq(dataRows.parentCategory, 'Expenses')))
      .orderBy(dataRows.category);
    availableCategories = catRows.map((r) => r.category);
  } else {
    const catSet = new Set<string>();
    for (const row of aggRows) {
      if (row.parentCategory === 'Expenses') catSet.add(row.category);
    }
    availableCategories = [...catSet].sort();
  }

  // -- reshape aggregated rows into chart series --
  const activeCategories = filters?.categories?.length
    ? new Set(filters.categories)
    : null;

  const revenueByBucket = new Map<string, number>();
  const expenseTotals = new Map<string, number>();
  const expenseByBucketCategory = new Map<string, Map<string, number>>();
  const revenueByYearMonth = new Map<string, Map<number, number>>();

  for (const row of aggRows) {
    const amt = parseFloat(row.total);
    const key = row.bucket;

    if (row.parentCategory === 'Income') {
      revenueByBucket.set(key, (revenueByBucket.get(key) ?? 0) + amt);

      const year = String(Number(row.year));
      const monthIdx = Number(row.monthIdx);
      if (!revenueByYearMonth.has(year)) revenueByYearMonth.set(year, new Map());
      revenueByYearMonth.get(year)!.set(monthIdx, (revenueByYearMonth.get(year)!.get(monthIdx) ?? 0) + amt);
    } else if (row.parentCategory === 'Expenses') {
      if (activeCategories && !activeCategories.has(row.category)) continue;
      expenseTotals.set(row.category, (expenseTotals.get(row.category) ?? 0) + amt);

      if (!expenseByBucketCategory.has(key)) expenseByBucketCategory.set(key, new Map());
      expenseByBucketCategory.get(key)!.set(row.category, (expenseByBucketCategory.get(key)!.get(row.category) ?? 0) + amt);
    }
  }

  // -- build output series --
  const revenueTrend = [...revenueByBucket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, revenue]) => ({ month: bucketLabel(key, granularity), revenue: round2(revenue) }));

  const expenseBreakdown = [...expenseTotals.entries()]
    .map(([category, total]) => ({ category, total: round2(total) }))
    .sort((a, b) => b.total - a.total);

  const allExpenseCategories = [...expenseTotals.keys()].sort();
  const expenseTrend = [...expenseByBucketCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, catMap]) => {
      const point: Record<string, string | number> = { month: bucketLabel(key, granularity) };
      for (const cat of allExpenseCategories) {
        point[cat] = round2(catMap.get(cat) ?? 0);
      }
      return point;
    });

  const allBucketKeys = new Set([...revenueByBucket.keys(), ...expenseByBucketCategory.keys()]);
  const monthlyComparison = [...allBucketKeys].sort().map((key) => {
    const revenue = round2(revenueByBucket.get(key) ?? 0);
    const totalExpense = expenseByBucketCategory.has(key)
      ? [...expenseByBucketCategory.get(key)!.values()].reduce((s, v) => s + v, 0)
      : 0;
    const expenses = round2(totalExpense);
    return { month: bucketLabel(key, granularity), revenue, expenses, profit: round2(revenue - expenses) };
  });

  const years = [...revenueByYearMonth.keys()].sort();
  const yoyComparison = years.length >= 2
    ? Array.from({ length: 12 }, (_, monthIdx) => {
        const currentYear = years[years.length - 1]!;
        const priorYear = years[years.length - 2]!;
        const current = revenueByYearMonth.get(currentYear)?.get(monthIdx) ?? 0;
        const prior = revenueByYearMonth.get(priorYear)?.get(monthIdx) ?? 0;
        const changePercent = prior > 0 ? Math.round(((current - prior) / prior) * 1000) / 10 : null;
        return {
          month: MONTH_LABELS[monthIdx]!,
          currentYear: round2(current),
          priorYear: round2(prior),
          changePercent,
          currentYearLabel: currentYear,
          priorYearLabel: priorYear,
        };
      }).filter((p) => p.currentYear > 0 || p.priorYear > 0)
    : [];

  return { revenueTrend, expenseBreakdown, expenseTrend, monthlyComparison, yoyComparison, availableCategories, dateRange };
}

/**
 * True when `computeMarginTrend` would emit for this org's rows. Mirrors the
 * pipeline's predicate exactly: union of months with income or expenses ≥ 4,
 * and both chronological halves carry non-zero revenue. Deterministic from
 * row shape, so the dashboard can decide whether to show the break-even
 * locked card before the AI summary streams.
 */
export async function getHasMarginSignal(
  orgId: number,
  client: typeof db | DbTransaction = db,
  datasetId?: number,
): Promise<boolean> {
  const scope = scopeConditions(orgId, datasetId);

  const rows = await client
    .select({
      bucket: sql<string>`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`.as('bucket'),
      parentCategory: dataRows.parentCategory,
      total: sql<string>`sum(${dataRows.amount})`.as('total'),
    })
    .from(dataRows)
    .where(and(...scope))
    .groupBy(
      sql`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`,
      dataRows.parentCategory,
    );

  const revenueByMonth = new Map<string, number>();
  const expenseByMonth = new Map<string, number>();
  for (const r of rows) {
    const amt = parseFloat(r.total);
    if (!Number.isFinite(amt)) continue;
    if (r.parentCategory === 'Income') {
      revenueByMonth.set(r.bucket, (revenueByMonth.get(r.bucket) ?? 0) + amt);
    } else if (r.parentCategory === 'Expenses') {
      expenseByMonth.set(r.bucket, (expenseByMonth.get(r.bucket) ?? 0) + amt);
    }
  }

  const months = [...new Set([...revenueByMonth.keys(), ...expenseByMonth.keys()])].sort();
  if (months.length < 4) return false;

  const half = Math.floor(months.length / 2);
  const priorRevenue = months.slice(0, half).reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);
  const recentRevenue = months.slice(half).reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);

  return priorRevenue > 0 && recentRevenue > 0;
}
