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

import type { ComputedStat, CashFlowStat, RunwayStat } from './types.js';
import { StatType } from './types.js';

export interface RunwayFinancials {
  cashOnHand?: number;
  cashAsOfDate?: string;
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

    // all identical values — no anomalies possible
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

function computeMarginTrend(rows: DataRow[]): ComputedStat[] {
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

// Trailing-window cash flow. Uses the same monthly bucket pattern as
// computeMarginTrend, but looks at the *recent* window because cash pressure
// is about now, not historical average. Signed monthlyNet — negative = burning.
function computeCashFlow(rows: DataRow[], trailingMonths = 3): CashFlowStat[] {
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
  if (months.length < trailingMonths) return [];

  const window = months.slice(-trailingMonths);
  const recentMonths = window.map((m) => {
    const revenue = revenueByMonth.get(m) ?? 0;
    const expenses = expenseByMonth.get(m) ?? 0;
    return { month: m, revenue, expenses, net: revenue - expenses };
  });

  // Guards run in order — each is a reason to say nothing rather than say
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
 * aggregated — the LLM gets numbers, not rows.
 *
 * Suppression cases return [] rather than throw — nothing honest to say.
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

  return [
    ...computeTotals(groups, allAmounts),
    ...computeAverages(groups, allAmounts),
    ...computeTrends(groups, trendMinPoints),
    ...detectAnomalies(groups),
    ...computeCategoryBreakdowns(groups),
    ...computeYearOverYear(rows),
    ...computeMarginTrend(rows),
    ...computeSeasonalProjection(rows),
    ...cashFlowStats,
    ...runwayStats,
  ];
}
