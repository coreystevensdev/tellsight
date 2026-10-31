import { mean, median } from 'simple-statistics';

import type { CashFlowStat } from './types.js';
import { StatType } from './types.js';
import { monthKey, parseAmount, type DataRow } from './computationPrimitives.js';

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

    const key = monthKey(row.date);
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

function buildCashFlowStat(
  buckets: MonthlyBucketMap,
  trailingMonths: number,
  suppressNearZero: boolean,
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
  if (suppressNearZero && Math.abs(monthlyNet) < 0.05 * avgMonthlyRevenue) return [];

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
 * Cash-flow analysis on pre-aggregated monthly buckets. Takes the last
 * `trailingMonths` buckets (chronologically) and calls the shared
 * buildCashFlowStat core with the break-even band guard enabled, on top of
 * the zero-revenue-month and non-positive-avg-revenue guards it always runs.
 *
 * This is the dashboard/digest/AI-summary path, both computeCashFlow(rows)
 * (for the curation pipeline) and the /cash-forecast endpoint (for
 * SQL-aggregated data) call this. Suppression semantics are identical
 * across both paths. See cashFlowForAlerting for the alert-only variant
 * that skips the band guard.
 */
export function cashFlowFromBuckets(
  buckets: MonthlyBucketMap,
  trailingMonths = 3,
): CashFlowStat[] {
  return buildCashFlowStat(buckets, trailingMonths, true);
}

/**
 * Same analysis as cashFlowFromBuckets but with the break-even band guard
 * off. evaluateCashBurn needs a real signal even for orgs sitting near
 * break-even, that population is the most likely to have a genuine spike
 * worth alerting on, and the dashboard's near-zero suppression exists to
 * avoid misleading AI commentary on the dashboard, not to hide alert-worthy
 * spikes (DW-7). No dashboard/digest consumer calls this directly, but a
 * fired result does still reach the alert email's AI paragraph and chart
 * (evaluateOrg.ts -> send.ts), it isn't fully isolated from AI commentary.
 */
export function cashFlowForAlerting(
  buckets: MonthlyBucketMap,
  trailingMonths = 3,
): CashFlowStat[] {
  return buildCashFlowStat(buckets, trailingMonths, false);
}

/**
 * Trailing-window cash flow from raw rows. Thin wrapper over the bucket-based
 * analysis, see cashFlowFromBuckets for the suppression contract.
 */
export function computeCashFlow(rows: DataRow[], trailingMonths = 3): CashFlowStat[] {
  return cashFlowFromBuckets(bucketRowsByMonth(rows), trailingMonths);
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
