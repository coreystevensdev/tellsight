import { eq, and, inArray, sql, gte, lte, type SQL } from 'drizzle-orm';
import type {
  CategoryPlan,
  CategoryVarianceItem,
  ChartData,
  ChartFilters,
  Granularity,
} from 'shared/types';
import { db, type DbTransaction } from '../../lib/db.js';
import {
  financialEffect,
  hasCostVisibility,
} from '../../services/curation/computationPrimitives.js';

// Both affect the expense side, so both have to pass a filter that selects it.
// The sign is applied after aggregation, never in the predicate.
const EXPENSE_SIDE = ['Expenses', 'ExpensesContra'];
import { dataRows } from '../schema.js';

// The slice of ChartData this query produces; the route wraps it with the org
// and dataset fields. Derived from the schema rather than restated, so a change
// to any of the point schemas is a compile error here instead of a wrong number
// in the browser. Nothing parsed chartDataSchema at runtime and this function
// declared no return type, which is how the same mislabelled year-over-year
// field came to exist twice without either copy forcing the other to be right
// (DW-31, DW-222).
export type ChartSeries = Pick<
  ChartData,
  | 'revenueTrend'
  | 'expenseBreakdown'
  | 'expenseTrend'
  | 'monthlyComparison'
  | 'yoyComparison'
  | 'availableCategories'
  | 'dateRange'
>;

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
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
 * 1. Metadata (unfiltered), distinct expense categories + date range
 * 2. Aggregated buckets (filtered), SUM(amount) grouped by time bucket + category
 *
 * Returns ~50-200 rows from the DB instead of 2,000 individual data_rows.
 */
export async function getChartData(
  orgId: number,
  filters?: ChartFilters,
  _limit?: number,
  client: typeof db | DbTransaction = db,
  datasetId?: number,
): Promise<ChartSeries> {
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

  const meta = metaRows[0];
  const dateRange =
    meta?.minDate && meta?.maxDate ? { min: meta.minDate, max: meta.maxDate } : null;

  // categories come from the aggregated rows (all expense categories present in data)
  // but we need unfiltered categories for the filter dropdown. If date filters are active,
  // a category might be absent from aggRows. We'll collect from a quick distinct query only
  // when filters could hide categories.
  let availableCategories: string[];
  if (filters?.dateFrom || filters?.dateTo) {
    const catRows = await client
      .selectDistinct({ category: dataRows.category })
      .from(dataRows)
      .where(and(...scope, inArray(dataRows.parentCategory, EXPENSE_SIDE)))
      .orderBy(dataRows.category);
    availableCategories = catRows.map((r) => r.category);
  } else {
    const catSet = new Set<string>();
    for (const row of aggRows) {
      if (financialEffect(row)?.side === 'Expenses') catSet.add(row.category);
    }
    availableCategories = [...catSet].sort();
  }

  const activeCategories = filters?.categories?.length ? new Set(filters.categories) : null;

  const revenueByBucket = new Map<string, number>();
  const expenseTotals = new Map<string, number>();
  const expenseByBucketCategory = new Map<string, Map<string, number>>();
  const revenueByYearMonth = new Map<string, Map<number, number>>();

  for (const row of aggRows) {
    const amt = parseFloat(row.total);
    const key = row.bucket;

    const effect = financialEffect(row);
    const signed = effect ? effect.sign * amt : amt;

    if (effect?.side === 'Income') {
      revenueByBucket.set(key, (revenueByBucket.get(key) ?? 0) + signed);

      const year = String(Number(row.year));
      const monthIdx = Number(row.monthIdx);
      if (!revenueByYearMonth.has(year)) revenueByYearMonth.set(year, new Map());
      revenueByYearMonth
        .get(year)!
        .set(monthIdx, (revenueByYearMonth.get(year)!.get(monthIdx) ?? 0) + signed);
    } else if (effect?.side === 'Expenses') {
      if (activeCategories && !activeCategories.has(row.category)) continue;
      expenseTotals.set(row.category, (expenseTotals.get(row.category) ?? 0) + signed);

      if (!expenseByBucketCategory.has(key)) expenseByBucketCategory.set(key, new Map());
      expenseByBucketCategory
        .get(key)!
        .set(row.category, (expenseByBucketCategory.get(key)!.get(row.category) ?? 0) + signed);
    }
  }

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
    return {
      month: bucketLabel(key, granularity),
      revenue,
      expenses,
      profit: round2(revenue - expenses),
    };
  });

  const years = [...revenueByYearMonth.keys()].sort();
  const yoyComparison =
    years.length >= 2
      ? Array.from({ length: 12 }, (_, monthIdx) => {
          const currentYear = years[years.length - 1]!;
          const priorYear = years[years.length - 2]!;
          const current = revenueByYearMonth.get(currentYear)?.get(monthIdx) ?? 0;
          const prior = revenueByYearMonth.get(priorYear)?.get(monthIdx) ?? 0;
          const changePercent =
            prior > 0 ? Math.round(((current - prior) / prior) * 1000) / 10 : null;
          return {
            month: MONTH_LABELS[monthIdx]!,
            currentRevenue: round2(current),
            priorRevenue: round2(prior),
            changePercent,
            currentYearLabel: currentYear,
            priorYearLabel: priorYear,
          };
        }).filter((p) => p.currentRevenue > 0 || p.priorRevenue > 0)
      : [];

  return {
    revenueTrend,
    expenseBreakdown,
    expenseTrend,
    monthlyComparison,
    yoyComparison,
    availableCategories,
    dateRange,
  };
}

export interface CategoryVarianceWindow {
  monthLabel: string;
  actualByCategory: Map<string, number>;
}

/**
 * Resolves the latest calendar month with any data, excluding the current
 * month, then sums that month's expenses by category. This is
 * computeCategoryVariance's month rule (categoryMetrics.ts:32-59) run again
 * as SQL: that function only ever sees DataRow[] inside the curation
 * pipeline and nothing persists its result for this route to read, and
 * expenseBreakdown above can't substitute because it sums whatever range the
 * dashboard filter covers, not one pinned month.
 *
 * Takes no plans: which categories matter is a join the caller does once
 * both this and the plans fetch resolve, so the two queries don't have to
 * wait on each other.
 */
export async function getCategoryVarianceWindow(
  orgId: number,
  client: typeof db | DbTransaction = db,
  datasetId?: number,
  now: Date = new Date(),
): Promise<CategoryVarianceWindow | null> {
  const scope = scopeConditions(orgId, datasetId);
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // < not <>: a row typo'd into next year, or a forecast row, has to lose the
  // max() the same way the current month does. !== alone lets any later
  // month win and reports every category wildly under plan against data that
  // hasn't happened yet. categoryMetrics.ts's completeMonths filter had the
  // same gap, fixed there too.
  // Expenses only, matching the actuals below. Without it any row can win the
  // max() and name a month the actuals query then finds nothing in, so every
  // planned category reads 100% under plan. A Shopify product row is dated
  // syncedAt and carries inventory value, which is exactly such a row.
  const [monthRow] = await client
    .select({
      month: sql<string | null>`to_char(max(date_trunc('month', ${dataRows.date})), 'YYYY-MM')`,
    })
    .from(dataRows)
    .where(
      and(
        ...scope,
        inArray(dataRows.parentCategory, EXPENSE_SIDE),
        sql`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM') < ${currentMonth}`,
      ),
    );

  const targetMonth = monthRow?.month ?? null;
  if (!targetMonth) return null;

  // abs(): unlike every other sum in this file, this number is compared
  // against a figure the owner typed into the plans UI, which is always
  // nonnegative (categoryPlanSchema). A CSV with its own parent_category
  // column stores amount verbatim, sign included (normalizer.ts), so a bank
  // export carrying negative expense rows alongside that column is real
  // input, not a hypothetical, and raw sum() would flip the comparison's
  // sign entirely rather than just its magnitude.
  //
  // The CASE then puts back the one negative that is a reduction rather than a
  // sign convention. abs() alone would have turned a vendor credit into spend,
  // which is the opposite of what it does to the bill it offsets.
  const expenseRows = await client
    .select({
      category: dataRows.category,
      total: sql<string>`sum(
        CASE WHEN ${dataRows.parentCategory} = 'ExpensesContra'
             THEN -abs(${dataRows.amount})
             ELSE abs(${dataRows.amount})
        END
      )`,
    })
    .from(dataRows)
    .where(
      and(
        ...scope,
        inArray(dataRows.parentCategory, EXPENSE_SIDE),
        sql`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM') = ${targetMonth}`,
      ),
    )
    .groupBy(dataRows.category);

  return {
    monthLabel: bucketLabel(targetMonth, 'monthly'),
    actualByCategory: new Map(expenseRows.map((r) => [r.category, round2(parseFloat(r.total))])),
  };
}

/**
 * Combines plans with a resolved window into chart rows. Iterates plans, not
 * actualByCategory: a planned category with no spend this month still gets a
 * row (actualMonthly 0, the same "you planned it and nothing went out"
 * finding categoryMetrics.ts makes), and a category with no plan is left out
 * rather than shown as a zero budget. Same 5% on-plan band and same
 * zero-plan guard as computeCategoryVariance, so the chart and the digest
 * text it feeds never disagree about which categories are over or under.
 */
export function buildCategoryVariance(
  plans: CategoryPlan[],
  window: CategoryVarianceWindow | null,
): CategoryVarianceItem[] {
  if (!window) return [];

  return plans.map((plan) => {
    const actualMonthly = window.actualByCategory.get(plan.category) ?? 0;
    const variance = round2(actualMonthly - plan.plannedMonthly);
    const variancePercent = plan.plannedMonthly === 0 ? 0 : (variance / plan.plannedMonthly) * 100;
    const direction: CategoryVarianceItem['direction'] =
      Math.abs(variancePercent) < 5 ? 'on_plan' : variance > 0 ? 'over' : 'under';

    return {
      category: plan.category,
      plannedMonthly: plan.plannedMonthly,
      actualMonthly,
      variance,
      variancePercent: Math.round(variancePercent * 10) / 10,
      monthLabel: window.monthLabel,
      direction,
    };
  });
}

/**
 * True when `computeMarginTrend` would emit for this org's rows. Mirrors the
 * pipeline's predicate: union of months with income or expenses >= 4, both
 * chronological halves carry non-zero revenue, the prior half carries non-zero
 * expense, and at least one expense row came from a source that can see
 * operating costs. Deterministic from row shape, so the dashboard can decide
 * whether to show the break-even locked card before the AI summary streams.
 *
 * The prior-expense condition arrived in the pipeline with DW-252 and was never
 * added here, so this returned true for a dataset the pipeline suppressed and
 * the comment claiming an exact mirror was wrong for as long as that stood. The
 * source condition is DW-261. Both predicates now go through
 * `hasCostVisibility`, which is the only way to stop them drifting again.
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
      // Grouped in so the source condition can be evaluated on the same rows.
      // Splits each bucket per source, which changes nothing downstream: every
      // total is summed into a per-month map either way.
      sourceType: dataRows.sourceType,
      total: sql<string>`sum(${dataRows.amount})`.as('total'),
    })
    .from(dataRows)
    .where(and(...scope))
    .groupBy(
      sql`to_char(date_trunc('month', ${dataRows.date}), 'YYYY-MM')`,
      dataRows.parentCategory,
      dataRows.sourceType,
    );

  const revenueByMonth = new Map<string, number>();
  const expenseByMonth = new Map<string, number>();
  for (const r of rows) {
    const amt = parseFloat(r.total);
    if (!Number.isFinite(amt)) continue;
    const rEffect = financialEffect(r);
    const rSigned = rEffect ? rEffect.sign * amt : amt;
    if (rEffect?.side === 'Income') {
      revenueByMonth.set(r.bucket, (revenueByMonth.get(r.bucket) ?? 0) + rSigned);
    } else if (rEffect?.side === 'Expenses') {
      expenseByMonth.set(r.bucket, (expenseByMonth.get(r.bucket) ?? 0) + rSigned);
    }
  }

  const months = [...new Set([...revenueByMonth.keys(), ...expenseByMonth.keys()])].sort();
  if (months.length < 4) return false;

  const half = Math.floor(months.length / 2);
  const priorRevenue = months.slice(0, half).reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);
  const recentRevenue = months.slice(half).reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);
  const priorExpense = months.slice(0, half).reduce((s, m) => s + (expenseByMonth.get(m) ?? 0), 0);

  if (priorRevenue <= 0 || recentRevenue === 0 || priorExpense <= 0) return false;
  return hasCostVisibility(rows);
}
