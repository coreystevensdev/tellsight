import {
  sum,
  mean,
  median,
  standardDeviation,
  linearRegression,
  quantile,
  min,
  max,
} from 'simple-statistics';

import type {
  ComputedStat,
  CashFlowStat,
  RunwayStat,
  BreakEvenStat,
  CashForecastStat,
  ProjectedMonth,
  MarginTrendStat,
  MarginTrendDetails,
} from './types.js';
import { StatType } from './types.js';

export interface RunwayFinancials {
  cashOnHand?: number;
  cashAsOfDate?: string;
  monthlyFixedCosts?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface DataRow {
  category: string;
  parentCategory?: string | null;
  date: Date;
  amount: string;
  label?: string | null;
  metadata?: unknown;
  [key: string]: unknown;
}

interface CategoryGroup {
  amounts: number[];
  timeSeries: [number, number][];
}

function parseAmount(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function groupByCategory(rows: DataRow[]): Map<string, CategoryGroup> {
  const groups = new Map<string, CategoryGroup>();

  for (const row of rows) {
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    let group = groups.get(row.category);
    if (!group) {
      group = { amounts: [], timeSeries: [] };
      groups.set(row.category, group);
    }

    group.amounts.push(amt);
    group.timeSeries.push([row.date.getTime(), amt]);
  }

  return groups;
}

function computeTotals(
  groups: Map<string, CategoryGroup>,
  allAmounts: number[],
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [cat, group] of groups) {
    stats.push({
      statType: StatType.Total,
      category: cat,
      value: sum(group.amounts),
      details: { scope: 'category', count: group.amounts.length },
    });
  }

  if (allAmounts.length > 0) {
    stats.push({
      statType: StatType.Total,
      category: null,
      value: sum(allAmounts),
      details: { scope: 'overall', count: allAmounts.length },
    });
  }

  return stats;
}

function computeAverages(
  groups: Map<string, CategoryGroup>,
  allAmounts: number[],
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [cat, group] of groups) {
    const med = median(group.amounts);
    stats.push({
      statType: StatType.Average,
      category: cat,
      value: mean(group.amounts),
      comparison: med,
      details: { scope: 'category', median: med },
    });
  }

  if (allAmounts.length > 0) {
    const med = median(allAmounts);
    stats.push({
      statType: StatType.Average,
      category: null,
      value: mean(allAmounts),
      comparison: med,
      details: { scope: 'overall', median: med },
    });
  }

  return stats;
}

function computeTrends(
  groups: Map<string, CategoryGroup>,
  minPoints: number,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [cat, group] of groups) {
    if (group.timeSeries.length < minPoints) continue;

    const sorted = [...group.timeSeries].sort((a, b) => a[0] - b[0]);
    const reg = linearRegression(sorted);

    const firstVal = sorted[0]![1];
    const lastVal = sorted[sorted.length - 1]![1];
    const growthPercent = firstVal !== 0 ? ((lastVal - firstVal) / Math.abs(firstVal)) * 100 : 0;

    stats.push({
      statType: StatType.Trend,
      category: cat,
      value: reg.m,
      details: {
        slope: reg.m,
        intercept: reg.b,
        growthPercent,
        dataPoints: sorted.length,
        firstValue: firstVal,
        lastValue: lastVal,
      },
    });
  }

  return stats;
}

function detectAnomalies(groups: Map<string, CategoryGroup>): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [cat, group] of groups) {
    if (group.amounts.length < 3) continue;

    const sorted = [...group.amounts].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;

    // all identical values, no anomalies possible
    if (iqr === 0) continue;

    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;

    for (const amt of group.amounts) {
      if (amt < lower || amt > upper) {
        const catMean = mean(group.amounts);
        const catStd = standardDeviation(group.amounts);
        const zScore = catStd > 0 ? (amt - catMean) / catStd : 0;

        stats.push({
          statType: StatType.Anomaly,
          category: cat,
          value: amt,
          comparison: catMean,
          details: {
            direction: amt > upper ? 'above' : 'below',
            zScore,
            iqrBounds: { lower, upper },
            deviation: amt - catMean,
          },
        });
      }
    }
  }

  return stats;
}

function computeCategoryBreakdowns(
  groups: Map<string, CategoryGroup>,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  let totalAbsolute = 0;
  for (const group of groups.values()) {
    totalAbsolute += group.amounts.reduce((acc, n) => acc + Math.abs(n), 0);
  }

  if (totalAbsolute === 0) return stats;

  for (const [cat, group] of groups) {
    const catAbsolute = group.amounts.reduce((acc, n) => acc + Math.abs(n), 0);
    const percentage = (catAbsolute / totalAbsolute) * 100;
    const catSum = sum(group.amounts);

    stats.push({
      statType: StatType.CategoryBreakdown,
      category: cat,
      value: catSum,
      details: {
        percentage,
        absoluteTotal: catAbsolute,
        transactionCount: group.amounts.length,
        min: min(group.amounts),
        max: max(group.amounts),
      },
    });
  }

  return stats;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function computeYearOverYear(rows: DataRow[]): ComputedStat[] {
  const revenueByYearMonth = new Map<number, Map<number, number>>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const year = row.date.getFullYear();
    const month = row.date.getMonth();
    if (!revenueByYearMonth.has(year)) revenueByYearMonth.set(year, new Map());
    const ym = revenueByYearMonth.get(year)!;
    ym.set(month, (ym.get(month) ?? 0) + amt);
  }

  const years = [...revenueByYearMonth.keys()].sort();
  if (years.length < 2) return [];

  const currentYear = years[years.length - 1]!;
  const priorYear = years[years.length - 2]!;
  const currentMap = revenueByYearMonth.get(currentYear)!;
  const priorMap = revenueByYearMonth.get(priorYear)!;

  const stats: ComputedStat[] = [];

  for (const [month, current] of currentMap) {
    const prior = priorMap.get(month);
    if (!prior || prior === 0) continue;

    const changePercent = ((current - prior) / prior) * 100;
    if (Math.abs(changePercent) < 3) continue;

    stats.push({
      statType: StatType.YearOverYear,
      category: 'Revenue',
      value: current,
      comparison: prior,
      details: {
        currentYear: current,
        priorYear: prior,
        currentYearLabel: String(currentYear),
        priorYearLabel: String(priorYear),
        changePercent: Math.round(changePercent * 10) / 10,
        month: MONTH_NAMES[month]!,
      },
    });
  }

  return stats;
}

function computeMarginTrend(rows: DataRow[]): MarginTrendStat[] {
  const revenueByMonth = new Map<string, number>();
  const expenseByMonth = new Map<string, number>();

  for (const row of rows) {
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
    if (row.parentCategory === 'Income') {
      revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + amt);
    } else if (row.parentCategory === 'Expenses') {
      expenseByMonth.set(key, (expenseByMonth.get(key) ?? 0) + amt);
    }
  }

  const months = [...new Set([...revenueByMonth.keys(), ...expenseByMonth.keys()])].sort();
  if (months.length < 4) return [];

  const half = Math.floor(months.length / 2);
  const recentMonths = months.slice(half);
  const priorMonths = months.slice(0, half);

  const recentRevenue = recentMonths.reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);
  const recentExpense = recentMonths.reduce((s, m) => s + (expenseByMonth.get(m) ?? 0), 0);
  const priorRevenue = priorMonths.reduce((s, m) => s + (revenueByMonth.get(m) ?? 0), 0);
  const priorExpense = priorMonths.reduce((s, m) => s + (expenseByMonth.get(m) ?? 0), 0);

  if (recentRevenue === 0 || priorRevenue === 0) return [];

  const recentMargin = ((recentRevenue - recentExpense) / recentRevenue) * 100;
  const priorMargin = ((priorRevenue - priorExpense) / priorRevenue) * 100;
  const diff = recentMargin - priorMargin;

  const direction = Math.abs(diff) < 2 ? 'stable' as const
    : diff > 0 ? 'expanding' as const
    : 'shrinking' as const;

  const revenueGrowth = ((recentRevenue - priorRevenue) / priorRevenue) * 100;
  const expenseGrowth = ((recentExpense - priorExpense) / priorExpense) * 100;

  return [{
    statType: StatType.MarginTrend,
    category: null,
    value: recentMargin,
    comparison: priorMargin,
    details: {
      recentMarginPercent: Math.round(recentMargin * 10) / 10,
      priorMarginPercent: Math.round(priorMargin * 10) / 10,
      direction,
      revenueGrowthPercent: Math.round(revenueGrowth * 10) / 10,
      expenseGrowthPercent: Math.round(expenseGrowth * 10) / 10,
    },
  }];
}

function computeSeasonalProjection(rows: DataRow[]): ComputedStat[] {
  const revenueByYearMonth = new Map<number, Map<number, number>>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const year = row.date.getFullYear();
    const month = row.date.getMonth();
    if (!revenueByYearMonth.has(year)) revenueByYearMonth.set(year, new Map());
    revenueByYearMonth.get(year)!.set(month, (revenueByYearMonth.get(year)!.get(month) ?? 0) + amt);
  }

  const years = [...revenueByYearMonth.keys()].sort();
  if (years.length < 2) return [];

  const latestYear = years[years.length - 1]!;
  const latestMonths = [...(revenueByYearMonth.get(latestYear)?.keys() ?? [])].sort((a, b) => a - b);
  if (latestMonths.length === 0) return [];

  const lastMonth = latestMonths[latestMonths.length - 1]!;
  const nextMonth = (lastMonth + 1) % 12;
  const nextYear = nextMonth === 0 ? latestYear + 1 : latestYear;

  const basisValues: number[] = [];
  const basisMonths: string[] = [];
  for (const year of years) {
    const val = revenueByYearMonth.get(year)?.get(nextMonth);
    if (val !== undefined) {
      basisValues.push(val);
      basisMonths.push(`${MONTH_NAMES[nextMonth]} ${year}`);
    }
  }

  if (basisValues.length === 0) return [];

  const latestYearGrowth = years.length >= 2
    ? (() => {
        const curr = [...(revenueByYearMonth.get(latestYear)?.values() ?? [])].reduce((s, v) => s + v, 0);
        const prev = [...(revenueByYearMonth.get(years[years.length - 2]!)?.values() ?? [])].reduce((s, v) => s + v, 0);
        return prev > 0 ? (curr - prev) / prev : 0;
      })()
    : 0;

  const baseProjection = mean(basisValues);
  const projected = Math.round(baseProjection * (1 + latestYearGrowth));
  const confidence = basisValues.length >= 3 ? 'high' as const
    : basisValues.length === 2 ? 'moderate' as const
    : 'low' as const;

  return [{
    statType: StatType.SeasonalProjection,
    category: 'Revenue',
    value: projected,
    details: {
      projectedMonth: `${MONTH_NAMES[nextMonth]} ${nextYear}`,
      projectedAmount: projected,
      basisMonths,
      basisValues,
      confidence,
    },
  }];
}

/**
 * Monthly revenue/expenses, keyed by YYYY-MM. The privacy-preserving shape
 * that every monthly-bucket analysis downstream of raw rows consumes. Either
 * built from rows (legacy path, via bucketRowsByMonth) or fetched directly
 * from SQL (efficient path for endpoints that only need aggregates).
 */
export type MonthlyBucketMap = Map<string, { revenue: number; expenses: number }>;

/**
 * Group rows into monthly revenue/expenses buckets. The single row-access
 * seam for cash-flow analysis, every downstream function works on the map,
 * not rows. Mirrors the convention `computeMarginTrend` and
 * `monthlyNetsWindow` have used internally since 8.1; extracted here so the
 * SQL path can reuse the downstream analysis unchanged.
 */
export function bucketRowsByMonth(rows: DataRow[]): MonthlyBucketMap {
  const buckets: MonthlyBucketMap = new Map();

  for (const row of rows) {
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
    const bucket = buckets.get(key) ?? { revenue: 0, expenses: 0 };
    if (row.parentCategory === 'Income') {
      bucket.revenue += amt;
    } else if (row.parentCategory === 'Expenses') {
      bucket.expenses += amt;
    }
    buckets.set(key, bucket);
  }

  return buckets;
}

/**
 * Cash-flow analysis on pre-aggregated monthly buckets. Takes the last
 * `trailingMonths` buckets (chronologically), applies three suppression
 * guards (zero-revenue month, non-positive avg revenue, break-even band),
 * and emits a CashFlowStat or [].
 *
 * This is the shared analytical core, both computeCashFlow(rows) (for the
 * curation pipeline) and the /cash-forecast endpoint (for SQL-aggregated data)
 * call this. Suppression semantics are identical across both paths.
 */
export function cashFlowFromBuckets(
  buckets: MonthlyBucketMap,
  trailingMonths = 3,
): CashFlowStat[] {
  const months = [...buckets.keys()].sort();
  if (months.length < trailingMonths) return [];

  const window = months.slice(-trailingMonths);
  const recentMonths = window.map((m) => {
    const bucket = buckets.get(m) ?? { revenue: 0, expenses: 0 };
    return { month: m, revenue: bucket.revenue, expenses: bucket.expenses, net: bucket.revenue - bucket.expenses };
  });

  // Guards run in order, each is a reason to say nothing rather than say
  // something misleading. A data gap or ill-defined threshold should never
  // turn into AI commentary.
  if (recentMonths.some((m) => m.revenue === 0)) return [];

  const avgMonthlyRevenue = mean(recentMonths.map((m) => m.revenue));
  if (avgMonthlyRevenue <= 0) return [];

  const monthlyNet = median(recentMonths.map((m) => m.net));
  if (Math.abs(monthlyNet) < 0.05 * avgMonthlyRevenue) return [];

  const direction = monthlyNet < 0 ? 'burning' as const : 'surplus' as const;
  const monthsBurning = recentMonths.filter((m) => m.net < 0).length;

  return [{
    statType: StatType.CashFlow,
    category: null,
    value: monthlyNet,
    details: { monthlyNet, trailingMonths, direction, monthsBurning, recentMonths },
  }];
}

/**
 * Trailing-window cash flow from raw rows. Thin wrapper over the bucket-based
 * analysis, see cashFlowFromBuckets for the suppression contract.
 */
export function computeCashFlow(rows: DataRow[], trailingMonths = 3): CashFlowStat[] {
  return cashFlowFromBuckets(bucketRowsByMonth(rows), trailingMonths);
}

export function runwayConfidence(
  ageInDays: number,
  monthsBurning: number,
): 'high' | 'moderate' | 'low' {
  if (ageInDays <= 30 && monthsBurning >= 2) return 'high';
  if (ageInDays <= 90 && monthsBurning >= 1) return 'moderate';
  return 'low';
}

/**
 * Consumes an already-computed CashFlowStat (never raw DataRow[]) plus an
 * owner-provided cash balance. Privacy boundary: everything here is already
 * aggregated, the LLM gets numbers, not rows.
 *
 * Suppression cases return [] rather than throw, nothing honest to say.
 *   - No cash flow signal (business not burning, or cash flow suppressed upstream)
 *   - No cashOnHand or zero balance
 *   - Missing cashAsOfDate (can't derive confidence)
 *   - cashAsOfDate older than 180 days (stale → confidently wrong runway)
 *   - Direction !== 'burning'
 *
 * `now` is injectable for deterministic tests; defaults to wall-clock.
 */
export function computeRunway(
  cashFlowStats: CashFlowStat[],
  financials: RunwayFinancials | null | undefined,
  now: Date = new Date(),
): RunwayStat[] {
  if (cashFlowStats.length === 0) return [];
  const cashFlowStat = cashFlowStats[0]!;
  if (cashFlowStat.details.direction !== 'burning') return [];

  if (!financials?.cashOnHand || financials.cashOnHand <= 0) return [];
  if (!financials.cashAsOfDate) return [];

  const asOf = new Date(financials.cashAsOfDate);
  if (Number.isNaN(asOf.getTime())) return [];

  const ageInDays = Math.floor((now.getTime() - asOf.getTime()) / DAY_MS);
  // Negative age = future-dated cashAsOfDate (clock skew, timezone bug, user
  // error). Suppress rather than label stale data as 'high' confidence.
  if (ageInDays < 0) return [];
  if (ageInDays > 180) return [];

  const monthlyNet = cashFlowStat.details.monthlyNet;
  const runwayMonths = Math.round((financials.cashOnHand / Math.abs(monthlyNet)) * 10) / 10;
  const confidence = runwayConfidence(ageInDays, cashFlowStat.details.monthsBurning);

  return [{
    statType: StatType.Runway,
    category: null,
    value: runwayMonths,
    details: {
      cashOnHand: financials.cashOnHand,
      monthlyNet,
      runwayMonths,
      cashAsOfDate: financials.cashAsOfDate,
      confidence,
    },
  }];
}

/**
 * Revenue of the most recent month in the dataset. Parallel to the monthly
 * aggregation computeMarginTrend does internally, but returns a scalar: the
 * revenue of the latest YYYY-MM bucket. Empty input returns 0, which lets
 * computeBreakEven treat pre-revenue businesses as "gap equals the full target."
 *
 * Not pulled from CashFlowStat.details.recentMonths because CashFlow suppresses
 * for near-break-even businesses, borrowing its data would silently suppress
 * break-even for healthy orgs that genuinely need the reassuring framing.
 */
function latestMonthlyRevenue(rows: DataRow[]): number {
  const revenueByMonth = new Map<string, number>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
    revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + amt);
  }

  if (revenueByMonth.size === 0) return 0;
  const months = [...revenueByMonth.keys()].sort();
  return revenueByMonth.get(months[months.length - 1]!) ?? 0;
}

export function breakEvenConfidence(
  marginPercent: number,
  direction: MarginTrendDetails['direction'],
): 'high' | 'moderate' | 'low' {
  if (marginPercent >= 10) {
    return direction === 'shrinking' ? 'moderate' : 'high';
  }
  if (marginPercent >= 5) return 'moderate';
  return 'low';
}

/**
 * Consumes an already-computed MarginTrendStat plus two scalars. Privacy
 * boundary: no DataRow[], the aggregation is done upstream.
 *
 * Suppression cases return [], six of them, each a reason to say nothing
 * rather than something misleading:
 *   - No margin signal (MarginTrend suppressed: too little data or zero revenue)
 *   - monthlyFixedCosts null/undefined/zero (nothing to solve for)
 *   - currentMonthlyRevenue is NaN (upstream aggregation bug guard)
 *   - Non-positive margin (negative break-even is nonsensical; zero is infinite)
 *   - Margin below 2% (produces implausibly large break-even, 1% margin
 *     on $10k fixed costs = $1M revenue target, which misleads more than informs)
 *
 * The 2% threshold is editorial, not mathematical. CashFlow uses a 5% band for
 * its own suppression, different concerns, different thresholds, both documented.
 */
export function computeBreakEven(
  marginStats: MarginTrendStat[],
  monthlyFixedCosts: number | null | undefined,
  currentMonthlyRevenue: number,
): BreakEvenStat[] {
  if (marginStats.length === 0) return [];
  if (monthlyFixedCosts == null || monthlyFixedCosts === 0) return [];
  if (!Number.isFinite(currentMonthlyRevenue)) return [];

  const margin = marginStats[0]!;
  const marginPercent = margin.details.recentMarginPercent;

  if (marginPercent <= 0) return [];
  if (marginPercent < 2) return [];

  const breakEvenRevenue = Math.round(monthlyFixedCosts / (marginPercent / 100));
  const gap = breakEvenRevenue - currentMonthlyRevenue;
  const confidence = breakEvenConfidence(marginPercent, margin.details.direction);

  return [{
    statType: StatType.BreakEven,
    category: null,
    value: breakEvenRevenue,
    details: {
      monthlyFixedCosts,
      marginPercent,
      breakEvenRevenue,
      currentMonthlyRevenue,
      gap,
      confidence,
    },
  }];
}

/**
 * Net cash flow per month on pre-aggregated buckets. Drops zero-revenue
 * months (gap handling, same as cashFlowFromBuckets), returns the most
 * recent `windowSize` months in chronological order. Output feeds directly
 * into computeCashForecast.
 */
export function netsFromBuckets(
  buckets: MonthlyBucketMap,
  windowSize = 12,
): { months: string[]; nets: number[] } {
  const allMonths = [...buckets.keys()].sort();

  const months: string[] = [];
  const nets: number[] = [];
  for (const m of allMonths) {
    const bucket = buckets.get(m)!;
    if (bucket.revenue === 0) continue; // gap month, don't forecast on zero-revenue signal
    months.push(m);
    nets.push(bucket.revenue - bucket.expenses);
  }

  const start = Math.max(0, months.length - windowSize);
  return { months: months.slice(start), nets: nets.slice(start) };
}

/**
 * Monthly nets window from raw rows. Thin wrapper, see netsFromBuckets.
 * This is the legacy row-based entry point; endpoints that already have
 * pre-aggregated data (SQL GROUP BY) should call netsFromBuckets directly
 * to avoid the row fetch.
 */
export function monthlyNetsWindow(
  rows: DataRow[],
  windowSize = 12,
): { months: string[]; nets: number[] } {
  return netsFromBuckets(bucketRowsByMonth(rows), windowSize);
}

// `true` when any net is more than 2σ from the window mean, flags an outlier
// month that should soften forecast confidence even with enough data points.
function hasVolatileNets(values: number[]): boolean {
  if (values.length < 2) return false;
  const m = mean(values);
  const std = standardDeviation(values);
  if (std === 0) return false;
  return values.some((v) => Math.abs(v - m) > 2 * std);
}

// Month arithmetic on YYYY-MM keys with December → January rollover. Mirrors
// the inline pattern in computeSeasonalProjection; isolated here so a future
// refactor can unify both sites without hunting for divergences.
function nextMonthKey(yyyymm: string, delta: number): string {
  const [y, m] = yyyymm.split('-').map(Number);
  const monthIdx = (m! - 1) + delta;
  const yearAdd = Math.floor(monthIdx / 12);
  const nextMonth = ((monthIdx % 12) + 12) % 12;
  return `${y! + yearAdd}-${String(nextMonth + 1).padStart(2, '0')}`;
}

/**
 * Three-month forward forecast of cash balance, anchored on owner-provided
 * cashOnHand. Regresses on monthly net change (not balance) so the per-month
 * trend is the signal; the starting balance only shifts the y-intercept of
 * the projected line. Falls back to a flat rolling mean when the regression
 * is degenerate (all nets identical), which honestly reflects "no clear trend"
 * without suppressing a useful forecast.
 *
 * Privacy boundary: signature takes aggregated scalars only, monthlyNets is
 * the { months, nets } output of monthlyNetsWindow. No DataRow[] ever enters
 * this function. Matches the 8.3 computeBreakEven boundary exactly.
 *
 * Suppression cases return [], each a reason to say nothing rather than
 * something misleading:
 *   - No cash flow signal (CashFlow suppressed upstream)
 *   - No cashOnHand, or zero balance (nowhere to start the trajectory)
 *   - Missing cashAsOfDate (can't judge freshness)
 *   - cashAsOfDate in the future (clock skew, typo, timezone bug)
 *   - cashAsOfDate older than 180 days (projecting from stale data is wrong)
 *   - Fewer than 3 basis months (regression on 2 points is a line)
 */
export function computeCashForecast(
  cashFlowStats: CashFlowStat[],
  financials: RunwayFinancials | null | undefined,
  monthlyNets: { months: string[]; nets: number[] },
  now: Date = new Date(),
): CashForecastStat[] {
  if (cashFlowStats.length === 0) return [];
  if (!financials?.cashOnHand || financials.cashOnHand <= 0) return [];
  if (!financials.cashAsOfDate) return [];

  const asOf = new Date(financials.cashAsOfDate);
  if (Number.isNaN(asOf.getTime())) return [];

  const ageInDays = Math.floor((now.getTime() - asOf.getTime()) / DAY_MS);
  if (ageInDays < 0) return [];
  if (ageInDays > 180) return [];

  const { months, nets } = monthlyNets;
  if (months.length < 3) return [];

  // linearRegression from simple-statistics takes [[x, y], ...] pairs.
  // Note: x is the index into `months`, not a calendar offset. `monthlyNetsWindow`
  // drops zero-revenue gap months, so a basis can be non-contiguous (Jan, Feb,
  // Apr, May, Jun with March missing). The regression treats these as evenly
  // spaced, projecting the trend over the observed non-gap months into the
  // next three calendar months. Businesses with persistent seasonal gaps may
  // see the slope understate the forward direction, acceptable for a v1
  // forecast; noted for future weighted-regression work.
  const points: [number, number][] = nets.map((y, i) => [i, y]);
  const reg = linearRegression(points);
  let slope = reg.m;
  let intercept = reg.b;
  let method: 'linear_regression' | 'rolling_mean' = 'linear_regression';
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) {
    slope = 0;
    intercept = mean(nets);
    method = 'rolling_mean';
  }

  const startingBalance = financials.cashOnHand;
  const n = months.length;
  const projectedMonths: ProjectedMonth[] = [];
  let runningBalance = startingBalance;

  for (let offset = 1; offset <= 3; offset++) {
    const t = n + offset - 1;
    const projectedNet = Math.round(slope * t + intercept);
    runningBalance = Math.round(runningBalance + projectedNet);
    projectedMonths.push({
      month: nextMonthKey(months[n - 1]!, offset),
      projectedNet,
      projectedBalance: runningBalance,
    });
  }

  const crossIdx = projectedMonths.findIndex((pm) => pm.projectedBalance < 0);
  const crossesZeroAtMonth: number | null = crossIdx === -1 ? null : crossIdx + 1;

  // First-match rule table, expressed as data so the contract reads like AC #12.
  // The final `true` default absorbs three 'moderate' cases the explicit rules
  // don't hit: (a) 31-90 days old with non-volatile nets, (b) fresh with a 2σ
  // outlier, (c) fewer than 31 days old but volatile. None earn 'high'; rule
  // 3's `ageInDays > 90` only catches the "stale cash" slice. Everything else
  // that isn't squarely 'high' or 'low' lands here.
  const rules: Array<[boolean, 'high' | 'moderate' | 'low']> = [
    [method === 'rolling_mean',                                        'low'],
    [months.length < 6,                                                'low'],
    [ageInDays > 90,                                                   'moderate'],
    [months.length >= 6 && ageInDays <= 30 && !hasVolatileNets(nets),  'high'],
    [true,                                                             'moderate'],
  ];
  const confidence = rules.find(([cond]) => cond)![1];

  return [{
    statType: StatType.CashForecast,
    category: null,
    value: runningBalance,
    details: {
      startingBalance,
      asOfDate: financials.cashAsOfDate,
      method,
      slope,
      intercept,
      basisMonths: months,
      basisValues: nets,
      projectedMonths,
      crossesZeroAtMonth,
      confidence,
    },
  }];
}

export function computeStats(
  rows: DataRow[],
  opts?: {
    trendMinPoints?: number;
    cashFlowWindow?: number;
    financials?: RunwayFinancials | null;
    now?: Date;
  },
): ComputedStat[] {
  if (rows.length === 0) return [];

  const groups = groupByCategory(rows);

  const allAmounts: number[] = [];
  for (const group of groups.values()) {
    allAmounts.push(...group.amounts);
  }

  if (allAmounts.length === 0) return [];

  const trendMinPoints = opts?.trendMinPoints ?? 3;
  const cashFlowWindow = opts?.cashFlowWindow ?? 3;

  const cashFlowStats = computeCashFlow(rows, cashFlowWindow);
  const runwayStats = computeRunway(cashFlowStats, opts?.financials, opts?.now);
  const marginStats = computeMarginTrend(rows);
  const currentMonthlyRevenue = latestMonthlyRevenue(rows);
  const breakEvenStats = computeBreakEven(
    marginStats,
    opts?.financials?.monthlyFixedCosts,
    currentMonthlyRevenue,
  );
  const monthlyNets = monthlyNetsWindow(rows, 12);
  const cashForecastStats = computeCashForecast(
    cashFlowStats,
    opts?.financials,
    monthlyNets,
    opts?.now,
  );

  return [
    ...computeTotals(groups, allAmounts),
    ...computeAverages(groups, allAmounts),
    ...computeTrends(groups, trendMinPoints),
    ...detectAnomalies(groups),
    ...computeCategoryBreakdowns(groups),
    ...computeYearOverYear(rows),
    ...marginStats,
    ...computeSeasonalProjection(rows),
    ...cashFlowStats,
    ...runwayStats,
    ...breakEvenStats,
    ...cashForecastStats,
  ];
}
