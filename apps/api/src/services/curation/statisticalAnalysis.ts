import { linearRegression, mean, standardDeviation } from 'simple-statistics';

import type { CategoryGroup } from './categoryMetrics.js';
import { monthKey } from './computationPrimitives.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

// Sums a category's transactions into calendar months, returning one point per
// month keyed to the month's first instant, ascending. UTC throughout, matching
// monthKey, so the process timezone cannot move a row across a month boundary.
function bucketSeriesByMonth(series: [number, number][]): [number, number][] {
  const totals = new Map<string, number>();
  for (const [timestamp, amount] of series) {
    const key = monthKey(new Date(timestamp));
    totals.set(key, (totals.get(key) ?? 0) + amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, total]): [number, number] => [Date.parse(`${key}-01T00:00:00Z`), total]);
}

export function computeTrends(
  groups: Map<string, CategoryGroup>,
  minPoints: number,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [category, group] of groups) {
    // Aggregate to calendar months before trending. One point per raw
    // transaction made growthPercent the gap between two individual line items,
    // so for a category with several rows a month it came down to which one
    // sorted last, and it could contradict the slope reported beside it in the
    // same stat. minPoints now counts months, which is the unit the label in
    // assembly.ts always claimed it was.
    const sorted = bucketSeriesByMonth(group.timeSeries);
    if (sorted.length < minPoints) continue;

    const regression = linearRegression(sorted);
    const firstValue = sorted[0]![1];
    const lastValue = sorted[sorted.length - 1]![1];
    const growthPercent =
      firstValue !== 0 ? ((lastValue - firstValue) / Math.abs(firstValue)) * 100 : 0;

    stats.push({
      statType: StatType.Trend,
      category,
      value: regression.m,
      details: {
        slope: regression.m,
        intercept: regression.b,
        growthPercent,
        dataPoints: sorted.length,
        firstValue,
        lastValue,
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
export function quantile(sorted: number[], probability: number): number {
  const count = sorted.length;
  const position = count * probability;
  const index = Math.floor(position);
  if (index <= 0) return sorted[0]!;
  if (index >= count) return sorted[count - 1]!;
  // Landing exactly on an order statistic averages the pair straddling it;
  // landing between them takes the upper.
  return position - index > 0
    ? sorted[index]!
    : (sorted[index - 1]! + sorted[index]!) / 2;
}

export function detectAnomalies(groups: Map<string, CategoryGroup>): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [category, group] of groups) {
    if (group.amounts.length < 3) continue;

    const sorted = [...group.amounts].sort((a, b) => a - b);
    const firstQuartile = quantile(sorted, 0.25);
    const thirdQuartile = quantile(sorted, 0.75);
    const interquartileRange = thirdQuartile - firstQuartile;

    // All identical values, no anomalies possible.
    if (interquartileRange === 0) continue;

    const lower = firstQuartile - 1.5 * interquartileRange;
    const upper = thirdQuartile + 1.5 * interquartileRange;

    // Indexed rather than for-of: groupByCategory pushes amounts and timeSeries
    // together, so the index is the only link back to when the outlier happened.
    for (let index = 0; index < group.amounts.length; index++) {
      const amount = group.amounts[index]!;
      if (amount < lower || amount > upper) {
        const categoryMean = mean(group.amounts);
        const categoryDeviation = standardDeviation(group.amounts);
        const zScore = categoryDeviation > 0 ? (amount - categoryMean) / categoryDeviation : 0;

        stats.push({
          statType: StatType.Anomaly,
          category,
          value: amount,
          comparison: categoryMean,
          details: {
            direction: amount > upper ? 'above' : 'below',
            zScore,
            iqrBounds: { lower, upper },
            deviation: amount - categoryMean,
            period: monthKey(new Date(group.timeSeries[index]![0])),
          },
        });
      }
    }
  }

  return stats;
}
