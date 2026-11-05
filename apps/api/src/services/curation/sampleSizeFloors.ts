import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

// Partial, an absent key means ungated (minimumSampleSize returns null).
//
// total, category_breakdown and category_variance stay absent: each sums or
// counts every transaction in its own scope rather than estimating from a
// sample, so there's no "too few data points" failure to guard against. A
// zero-transaction category_variance is still correct, "nothing went out" is
// a real finding (categoryMetrics.ts:41), not a thin one.
//
// year_over_year also stays absent, for an unrelated reason: its sampleSize
// is null by construction, two monthly totals rather than a count
// (revenueMetrics.ts:51), so a number here would never fire. Its "enough
// history" gate is structural and already runs before the stat exists,
// years.length < 2 (revenueMetrics.ts:28). seasonal_projection shares that
// same structural gate (revenueMetrics.ts:69) but still gets a real floor
// below: years.length >= 2 only guarantees two years of overall history, not
// that the projected month has a value in more than one of them.
//
// anomaly's floor is not about the IQR algorithm's false-positive rate, it's
// about whether quantile() (statisticalAnalysis.ts:83) can flag anything at
// all. Verified by brute force over random and adversarial inputs: at n <= 4
// the point under test is always at least half of the fence built to catch
// it, so nothing can ever clear it, 0% false positives at n = 4 is a
// guarantee, not a measurement. n = 8 is the first size afterward where each
// quartile boundary averages two real points instead of resting on one.
const SAMPLE_SIZE_FLOORS: Partial<Record<StatType, number>> = {
  [StatType.Average]: 3, // first n where the median is a real middle value, not an average of two restating the mean
  // Raising this moves the seed snapshot (scripts/__snapshots__/seed-validation.snap.json,
  // built on 12 months of data) and breaks eval-fixtures/fixtures.ts's trend
  // fixture, which sits at sampleSize 6 on purpose. Both would need updating
  // in the same change, not as a surprise.
  [StatType.Trend]: 6, // one outlier in 6 points is a sixth of the signal vs. a third at the compute floor (trendMinDataPoints: 3, config/scoring-weights.json); move both together
  [StatType.Anomaly]: 8, // see above
  // Raising this moves the seed snapshot the same way Trend's does -- the
  // seed fixture's 12 months split 6-and-6 sits exactly at this floor, not
  // above it, and eval-fixtures/fixtures.ts has margin_trend entries at the
  // same number.
  [StatType.MarginTrend]: 6, // per window, the thinner half (marginMetrics.ts:86), so this needs 12 months of data total, 6 on each side
  // Raising this breaks eval-fixtures/fixtures.ts's seasonal_projection
  // fixture, which sits at sampleSize 2 on purpose, one basis value above the
  // floor below.
  [StatType.SeasonalProjection]: 2, // see above; one basis value is already the code's own 'low' confidence (revenueMetrics.ts:106)
  [StatType.CashFlow]: 3, // monthlyNet is a median (cashFlowMetrics.ts:64), same reasoning as average; trailingMonths is pinned to 3 everywhere today (computation.ts:81), so this only guards a future shorter window
  [StatType.Runway]: 3, // inherits cash_flow's trailingMonths outright (financialMetrics.ts:70)
  [StatType.BreakEven]: 6, // inherits margin_trend's sampleSize outright (financialMetrics.ts:161); must equal margin_trend's floor
  [StatType.CashForecast]: 6, // matches this function's own confidence rule: months.length < 6 is already 'low' right here (cashForecastMetrics.ts:126)
};

export function minimumSampleSize(statType: StatType): number | null {
  return SAMPLE_SIZE_FLOORS[statType] ?? null;
}

export function isBelowFloor(stat: ComputedStat): boolean {
  if (stat.sampleSize === null) return false;
  // null means "no single meaningful n," stated on purpose (year_over_year).
  // Anything else non-finite, undefined, NaN, Infinity, compares false
  // either direction against a floor in JS, which read as "ungated" until
  // this line existed, three separate sites (a digest_history row, a test
  // factory, a test for this file) reached exactly that gap.
  if (!Number.isFinite(stat.sampleSize)) return true;
  const floor = minimumSampleSize(stat.statType);
  return floor !== null && stat.sampleSize < floor;
}

// The one place that turns "below floor" into the two real numbers a response
// can cite. isBelowFloor fails closed above (true) on a non-finite sampleSize
// even for a stat type with no floor at all, so "below floor" and "has a
// minimum worth citing" are different questions; this only answers yes to
// both, so a caller never has to invent a minimum or report a sampleSize that
// isn't a real count.
export function sampleFloorBreach(stat: ComputedStat): { sampleSize: number; minimum: number } | null {
  const minimum = minimumSampleSize(stat.statType);
  if (minimum === null || typeof stat.sampleSize !== 'number' || !Number.isFinite(stat.sampleSize)) {
    return null;
  }
  return isBelowFloor(stat) ? { sampleSize: stat.sampleSize, minimum } : null;
}
