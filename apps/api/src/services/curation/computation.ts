import {
  sum,
  mean,
  median,
  standardDeviation,
  linearRegression,
  min,
  max,
} from 'simple-statistics';

import type { CategoryPlan } from 'shared/types';

import type {
  ComputedStat,
  IdentifiedStat,
} from './types.js';
import { StatType } from './types.js';

import { monthKey, type DataRow } from './computationPrimitives.js';
import {
  computeBreakEven,
  computeCashFlow,
  computeCashForecast,
  computeRunway,
  latestMonthlyRevenue,
  monthlyNetsWindow,
  type RunwayFinancials,
} from './financialMetrics.js';
import { assignIds, findMatchingStat } from './statIdentity.js';
import { computeSeasonalProjection, computeYearOverYear } from './revenueMetrics.js';
import { computeMarginTrend } from './marginMetrics.js';
import {
  computeCategoryVariance,
  groupByCategory,
  type CategoryGroup,
} from './categoryMetrics.js';

export { MONTH_NAMES, monthKey } from './computationPrimitives.js';
export {
  breakEvenConfidence,
  bucketRowsByMonth,
  cashFlowForAlerting,
  cashFlowFromBuckets,
  computeBreakEven,
  computeCashFlow,
  computeCashForecast,
  computeRunway,
  monthlyNetsWindow,
  netsFromBuckets,
  runwayConfidence,
} from './financialMetrics.js';
export type { MonthlyBucketMap, RunwayFinancials } from './financialMetrics.js';
export {
  assignIds,
  findMatchingStat,
  hasValidDiscriminatorFields,
  matchesStatShape,
  statInstanceId,
} from './statIdentity.js';
export { marginTrendMonths } from './marginMetrics.js';
export { computeCategoryVariance } from './categoryMetrics.js';

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

// Sums a category's transactions into calendar months, returning one point per
// month keyed to the month's first instant, ascending. UTC throughout, matching
// monthKey, so the process timezone cannot move a row across a month boundary.
function bucketSeriesByMonth(series: [number, number][]): [number, number][] {
  const totals = new Map<string, number>();
  for (const [ts, amt] of series) {
    const key = monthKey(new Date(ts));
    totals.set(key, (totals.get(key) ?? 0) + amt);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, total]): [number, number] => [Date.parse(`${key}-01T00:00:00Z`), total]);
}

function computeTrends(
  groups: Map<string, CategoryGroup>,
  minPoints: number,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [cat, group] of groups) {
    // Aggregate to calendar months before trending. One point per raw
    // transaction made growthPercent the gap between two individual line items,
    // so for a category with several rows a month it came down to which one
    // sorted last, and it could contradict the slope reported beside it in the
    // same stat. minPoints now counts months, which is the unit the label in
    // assembly.ts always claimed it was.
    const sorted = bucketSeriesByMonth(group.timeSeries);
    if (sorted.length < minPoints) continue;

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

// The IQR fence below decides which transactions get called anomalies, so the
// quantile definition is product behaviour, not a utility call. There are nine
// standard definitions and they disagree most at the small sample sizes this
// runs on: simple-statistics silently switched from this one to R's type 7 in a
// patch release, which narrowed the fences and, measured on clean lognormal
// data, took the false-positive rate at n=4 from 0% to 5.9%.
//
// This is R type 2, the inverse CDF averaged at discontinuities. Chosen over
// type 7 (R, numpy and Excel's default) because it is quieter at every small n,
// and a transaction wrongly called an anomaly costs a reader more than one
// quietly missed.
//
// Verified identical to simple-statistics 7.8.8 across 180,000 cases at n from
// 3 to 42 before it was inlined.
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  const np = n * p;
  const j = Math.floor(np);
  if (j <= 0) return sorted[0]!;
  if (j >= n) return sorted[n - 1]!;
  // Landing exactly on an order statistic averages the pair straddling it;
  // landing between them takes the upper.
  return np - j > 0 ? sorted[j]! : (sorted[j - 1]! + sorted[j]!) / 2;
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

    // Indexed rather than for-of: groupByCategory pushes amounts and timeSeries
    // together, so i is the only link back to when the outlier happened.
    for (let i = 0; i < group.amounts.length; i++) {
      const amt = group.amounts[i]!;
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
            period: monthKey(new Date(group.timeSeries[i]![0])),
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

export function computeStats(
  rows: DataRow[],
  opts?: {
    trendMinPoints?: number;
    cashFlowWindow?: number;
    financials?: RunwayFinancials | null;
    categoryPlans?: CategoryPlan[] | null;
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
    ...computeCategoryVariance(groups, opts?.categoryPlans, opts?.now),
  ];
}

// Recomputes stats for a dataset and looks up one instance by id. DB-free
// (takes rows, not a datasetId to fetch), so the route and the test suite
// share this one implementation instead of duplicating the compute+assign+find
// sequence. `datasetId` here only feeds statInstanceId's id prefix, it plays
// no role in which rows get computed, an id minted for a different dataset
// simply never matches anything in this dataset's recomputed set.
export function resolveStatById(
  rows: DataRow[],
  datasetId: number,
  statId: string,
  opts?: Parameters<typeof computeStats>[1],
): IdentifiedStat | null {
  const identified = assignIds(computeStats(rows, opts), datasetId);
  return identified.find((s) => s.id === statId) ?? null;
}

// Same compute+assign sequence as resolveStatById, but for callers that only
// know a metric's shape (statType + optional category), not a citation id
// yet -- the NL Q&A tool registry's case.
export function resolveStatByType(
  rows: DataRow[],
  datasetId: number,
  statType: StatType,
  category?: string,
  opts?: Parameters<typeof computeStats>[1],
): IdentifiedStat | null {
  const identified = assignIds(computeStats(rows, opts), datasetId);
  return findMatchingStat(identified, statType, category);
}
