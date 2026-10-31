import { linearRegression, mean, standardDeviation } from 'simple-statistics';

import type {
  CashFlowStat,
  CashForecastStat,
  ProjectedMonth,
  RunwayFinancials,
} from './types.js';
import { StatType } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

  // First-match rule table. The final `true` default absorbs three 'moderate'
  // cases the explicit rules don't hit: (a) 31-90 days old with non-volatile
  // nets, (b) fresh with a 2σ outlier, (c) fewer than 31 days old but volatile.
  // None earn 'high'; everything that isn't squarely 'high' or 'low' lands here.
  //
  // There used to be an `[ageInDays > 90, 'moderate']` rule above the 'high'
  // one, described as catching the stale-cash slice. It never changed an answer:
  // anything older than 90 days also fails the `ageInDays <= 30` in the 'high'
  // rule, so it reached the same 'moderate' through the catch-all. Removing it
  // left every test green, which is how it was found. The staleness that does
  // decide something is the 30-day window in the 'high' rule.
  const rules: Array<[boolean, 'high' | 'moderate' | 'low']> = [
    [method === 'rolling_mean',                                        'low'],
    [months.length < 6,                                                'low'],
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
