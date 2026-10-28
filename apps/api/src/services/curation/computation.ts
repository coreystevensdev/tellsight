import type { CategoryPlan } from 'shared/types';

import type {
  ComputedStat,
  IdentifiedStat,
} from './types.js';
import { StatType } from './types.js';

import type { DataRow } from './computationPrimitives.js';
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
} from './categoryMetrics.js';
import {
  computeAverages,
  computeCategoryBreakdowns,
  computeTotals,
} from './descriptiveMetrics.js';
import { computeTrends, detectAnomalies } from './statisticalAnalysis.js';

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
export { quantile } from './statisticalAnalysis.js';

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
