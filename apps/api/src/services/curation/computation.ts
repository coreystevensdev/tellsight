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
  MarginTrendStat,
  CategoryVarianceStat,
} from './types.js';
import { StatType } from './types.js';

import { monthKey, parseAmount, type DataRow } from './computationPrimitives.js';
import {
  computeBreakEven,
  computeCashFlow,
  computeCashForecast,
  computeRunway,
  latestMonthlyRevenue,
  monthlyNetsWindow,
  type RunwayFinancials,
} from './financialMetrics.js';

export { monthKey } from './computationPrimitives.js';
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

interface CategoryGroup {
  amounts: number[];
  timeSeries: [number, number][];
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

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function computeYearOverYear(rows: DataRow[]): ComputedStat[] {
  const revenueByYearMonth = new Map<number, Map<number, number>>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const year = row.date.getUTCFullYear();
    const month = row.date.getUTCMonth();
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
        currentRevenue: current,
        priorRevenue: prior,
        currentYearLabel: String(currentYear),
        priorYearLabel: String(priorYear),
        changePercent: Math.round(changePercent * 10) / 10,
        month: MONTH_NAMES[month]!,
      },
    });
  }

  return stats;
}

// Recent/prior month split for margin trend analysis: the trailing half of
// months with Income or Expenses activity vs. the leading half. Extracted
// from computeMarginTrend so resolveSourceRows (sourceRows.ts) can recompute
// the same window without duplicating the split logic.
export function marginTrendMonths(rows: DataRow[]): { recentMonths: string[]; priorMonths: string[] } | null {
  const months = new Set<string>();
  for (const row of rows) {
    const amt = parseAmount(row.amount);
    if (amt === null) continue;
    if (row.parentCategory === 'Income' || row.parentCategory === 'Expenses') {
      months.add(monthKey(row.date));
    }
  }

  const sorted = [...months].sort();
  if (sorted.length < 4) return null;

  const half = Math.floor(sorted.length / 2);
  return { recentMonths: sorted.slice(half), priorMonths: sorted.slice(0, half) };
}

function computeMarginTrend(rows: DataRow[]): MarginTrendStat[] {
  const revenueByMonth = new Map<string, number>();
  const expenseByMonth = new Map<string, number>();

  for (const row of rows) {
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const key = monthKey(row.date);
    if (row.parentCategory === 'Income') {
      revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + amt);
    } else if (row.parentCategory === 'Expenses') {
      expenseByMonth.set(key, (expenseByMonth.get(key) ?? 0) + amt);
    }
  }

  const monthSplit = marginTrendMonths(rows);
  if (!monthSplit) return [];
  const { recentMonths, priorMonths } = monthSplit;

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

    const year = row.date.getUTCFullYear();
    const month = row.date.getUTCMonth();
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

// Plan versus actual, for the latest month the data covers in full.
//
// The current calendar month is excluded on purpose. A plan is a whole month's
// figure, so comparing it against three days of spend reports every category as
// massively under plan, which is the kind of confidently wrong insight this
// pipeline exists to avoid. One month of lag beats a wrong number.
//
// Only categories the owner actually planned produce a stat. A plan with no
// matching rows in that month still does, with an actual of zero: "you planned
// 2,400 for rent and nothing went out" is a real finding, not a gap.
export function computeCategoryVariance(
  groups: Map<string, CategoryGroup>,
  plans: CategoryPlan[] | null | undefined,
  now: Date = new Date(),
): CategoryVarianceStat[] {
  if (!plans?.length) return [];

  const currentMonth = monthKey(now);
  const months = new Set<string>();
  for (const group of groups.values()) {
    for (const [ts] of group.timeSeries) months.add(monthKey(new Date(ts)));
  }

  const complete = [...months].filter((m) => m !== currentMonth).sort();
  const target = complete[complete.length - 1];
  if (!target) return [];

  const stats: CategoryVarianceStat[] = [];

  // One stat per category, enforced here rather than trusted from the caller.
  // statDiscriminator returns a fixed placeholder for this type, so a second
  // stat for the same category would collide and assignIds would silently drop
  // it. The table has a unique index, but this function takes a plain array.
  const seen = new Set<string>();

  for (const plan of plans) {
    if (seen.has(plan.category)) continue;
    seen.add(plan.category);

    const group = groups.get(plan.category);
    let actualMonthly = 0;
    if (group) {
      for (const [ts, amt] of group.timeSeries) {
        if (monthKey(new Date(ts)) === target) actualMonthly += Math.abs(amt);
      }
    }

    const variance = actualMonthly - plan.plannedMonthly;
    // A zero plan has no percentage to report. Guard rather than emit Infinity,
    // which validateSummary would then have to recognise as not-a-figure.
    const variancePercent = plan.plannedMonthly === 0 ? 0 : (variance / plan.plannedMonthly) * 100;
    const direction = Math.abs(variancePercent) < 5 ? 'on_plan' : variance > 0 ? 'over' : 'under';

    stats.push({
      statType: StatType.CategoryVariance,
      category: plan.category,
      value: variance,
      details: {
        plannedMonthly: plan.plannedMonthly,
        actualMonthly,
        variance,
        variancePercent: Math.round(variancePercent * 10) / 10,
        monthLabel: target,
        direction,
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

// Per-instance id for the audit drawer and NL Q&A citation system.
// Different from allowedStatTypes (assembly.ts), which refers to stat *types*, not instances.
export function statInstanceId(stat: ComputedStat, datasetId: number): string {
  // Swap for lookalike characters rather than stripping. The quote swap
  // keeps a literal ASCII quote from breaking the <cite id="..."> attribute
  // delimiter downstream (assembly.ts). The colon swap is forward-hardening
  // (DW-32): keeping a literal colon out of category means the id can't be
  // misread by a parser that assumes datasetId:statType:category:discriminator
  // -- expire.ts's Anomaly re-validation sweep (DW-64) is exactly that parser,
  // splitting on ':' to read off the statType segment. Both swaps avoid
  // collapsing two categories that differ only by an escaped character onto
  // the same id, or an escaped-only category onto an empty segment.
  const category =
    stat.category == null ? '_' : stat.category.replace(/"/g, '”').replace(/:/g, '：');
  return `${datasetId}:${stat.statType}:${category}:${statDiscriminator(stat)}`;
}

// digestHistory.ts's isComputedStat calls this on every keyStats entry before
// casting jsonb to ComputedStat, and statDiscriminator (below) dereferences
// the same details fields with no guard of its own. Total and Average also
// dereference details.scope there, but neither is a TrendCarryingStatType so
// compareToPriorPeriods can never match one -- their case is still checked
// here so this guard holds even if that changes. Keep the two switches in
// sync: a stat type added to one and not the other reintroduces the drift
// DW-119 found.
export function hasValidDiscriminatorFields(stat: { statType: string; details: unknown }): boolean {
  const details = stat.details as Record<string, unknown> | null | undefined;
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return typeof details?.scope === 'string';
    case StatType.YearOverYear:
      return (
        typeof details?.currentRevenue === 'number' &&
        Number.isFinite(details.currentRevenue) &&
        typeof details?.month === 'string' &&
        (MONTH_NAMES as readonly string[]).includes(details.month)
      );
    case StatType.SeasonalProjection:
      return typeof details?.projectedMonth === 'string';
    case StatType.CashFlow:
      return typeof details?.trailingMonths === 'number' && Number.isFinite(details.trailingMonths);
    default:
      return true;
  }
}

function statDiscriminator(stat: ComputedStat): string {
  switch (stat.statType) {
    case StatType.Total:
    case StatType.Average:
      return stat.details.scope;
    case StatType.YearOverYear:
      // Deliberately the revenue figure and not currentYearLabel, even though
      // a year would read better in a citation id. These ids are embedded in
      // stored summaries as <stat id="..."/> and resolveStatById recomputes to
      // match them, so the string has to stay byte-identical to what the old
      // details.currentYear produced. Unique only because computeStats emits
      // one year-over-year window per call; see DW-219.
      return `${stat.details.currentRevenue}-${stat.details.month}`;
    case StatType.SeasonalProjection:
      return stat.details.projectedMonth;
    case StatType.CashFlow:
      return `w${stat.details.trailingMonths}`;
    case StatType.Anomaly:
      // Stays the value even though details.period now exists. These ids are
      // embedded in stored summaries as <stat id="..."/> and resolveStatById
      // recomputes to match them, so widening the discriminator would break the
      // audit drawer on every summary already written.
      return `v${stat.value}`;
    default:
      // trend, category_breakdown, margin_trend, runway, break_even, cash_forecast,
      // category_variance:
      // each producer emits at most one stat per (category, statType), so a fixed
      // placeholder is a safe id. If a producer ever emits more than one, the second
      // instance silently collides and assignIds drops it -- add a real discriminator
      // before that becomes possible.
      return '_';
  }
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

// Shared by resolveStatByType and the Q&A tool registry's digest-history
// matcher, so the two call sites can't drift on what "matches" means.
export function matchesStatShape(
  stat: { statType: StatType; category: string | null },
  statType: StatType,
  category?: string,
): boolean {
  return stat.statType === statType && (category === undefined || stat.category === category);
}

// computeYearOverYear emits one stat per significant month within the current
// year, all sharing (category: 'Revenue', statType: 'year_over_year') --
// statDiscriminator already accounts for this when minting ids. Every other
// producer emits at most one stat per shape, so this only has real work to
// do for year_over_year; array order otherwise reflects a single match.
function mostRecentMatch(matches: ComputedStat[]): ComputedStat {
  let latest = matches[0]!;
  for (const s of matches) {
    if (s.statType === StatType.YearOverYear && latest.statType === StatType.YearOverYear) {
      const monthNames: readonly string[] = MONTH_NAMES;
      if (monthNames.indexOf(s.details.month) > monthNames.indexOf(latest.details.month)) latest = s;
    }
  }
  return latest;
}

// Same matching rule as matchesStatShape, but resolves ambiguity when more
// than one stat shares (category, statType) instead of returning array order.
export function findMatchingStat<T extends ComputedStat>(stats: T[], statType: StatType, category?: string): T | null {
  const matches = stats.filter((s) => matchesStatShape(s, statType, category));
  return matches.length > 0 ? (mostRecentMatch(matches) as T) : null;
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

// Maps stats to IdentifiedStat[], deduping byte-identical entries (keeps first).
// Relies on each producer function emitting at most one stat per (category, statType),
// except Anomaly, whose only possible collision is two same-value anomalies in one
// category -- byte-identical (same zScore/deviation) and not citable apart anyway.
// Each stat is deep-cloned before the id is attached, so an IdentifiedStat never
// shares object identity (including nested arrays like CashFlowDetails.recentMonths)
// with the computeStats() output that produced it.
export function assignIds(stats: ComputedStat[], datasetId: number): IdentifiedStat[] {
  const byId = new Map<string, IdentifiedStat>();
  for (const s of stats) {
    const id = statInstanceId(s, datasetId);
    if (!byId.has(id)) byId.set(id, { ...structuredClone(s), id });
  }
  return [...byId.values()];
}
