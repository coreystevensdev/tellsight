import type {
  BreakEvenStat,
  CashFlowStat,
  MarginTrendDetails,
  MarginTrendStat,
  RunwayFinancials,
  RunwayStat,
} from './types.js';
import { StatType } from './types.js';
import { monthKey, parseAmount, type DataRow } from './computationPrimitives.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type { RunwayFinancials } from './types.js';

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
      trailingMonths: cashFlowStat.details.trailingMonths,
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
export function latestMonthlyRevenue(rows: DataRow[]): number {
  const revenueByMonth = new Map<string, number>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amt = parseAmount(row.amount);
    if (amt === null) continue;

    const key = monthKey(row.date);
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

export { computeCashForecast } from './cashForecastMetrics.js';
export {
  bucketRowsByMonth,
  cashFlowForAlerting,
  cashFlowFromBuckets,
  computeCashFlow,
  monthlyNetsWindow,
  netsFromBuckets,
} from './cashFlowMetrics.js';
export type { MonthlyBucketMap } from './cashFlowMetrics.js';
