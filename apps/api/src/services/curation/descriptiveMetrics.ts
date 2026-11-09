import { max, mean, median, min, sum } from 'simple-statistics';

import type { CategoryGroup } from './categoryMetrics.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

export function computeTotals(
  groups: Map<string, CategoryGroup>,
  allAmounts: number[],
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [category, group] of groups) {
    stats.push({
      statType: StatType.Total,
      category,
      value: sum(group.amounts),
      sampleSize: group.amounts.length,
      details: { scope: 'category', count: group.amounts.length },
    });
  }

  if (allAmounts.length > 0) {
    stats.push({
      statType: StatType.Total,
      category: null,
      value: sum(allAmounts),
      sampleSize: allAmounts.length,
      details: { scope: 'overall', count: allAmounts.length },
    });
  }

  return stats;
}

export function computeAverages(
  groups: Map<string, CategoryGroup>,
  allAmounts: number[],
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  for (const [category, group] of groups) {
    const categoryMedian = median(group.amounts);
    stats.push({
      statType: StatType.Average,
      category,
      value: mean(group.amounts),
      comparison: categoryMedian,
      sampleSize: group.amounts.length,
      details: { scope: 'category', median: categoryMedian },
    });
  }

  if (allAmounts.length > 0) {
    const overallMedian = median(allAmounts);
    stats.push({
      statType: StatType.Average,
      category: null,
      value: mean(allAmounts),
      comparison: overallMedian,
      sampleSize: allAmounts.length,
      details: { scope: 'overall', median: overallMedian },
    });
  }

  return stats;
}

export function computeCategoryBreakdowns(
  groups: Map<string, CategoryGroup>,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  // Shares are computed over net activity, so a contra entry reduces both this
  // denominator and its own category's numerator. Taking absolute values of the
  // nets rather than of each row keeps a credit from inflating the very share it
  // is meant to shrink, and keeps the percentages summing to 100.
  const netByCategory = new Map(
    [...groups].map(([category, group]) => [category, Math.abs(sum(group.amounts))]),
  );
  let totalAbsolute = 0;
  for (const categoryNet of netByCategory.values()) totalAbsolute += categoryNet;

  if (totalAbsolute === 0) return stats;

  for (const [category, group] of groups) {
    const categoryAbsolute = netByCategory.get(category)!;
    // A category that nets to nothing has no share to report, and dividing on
    // would emit a 0% breakdown that reads as a finding.
    if (categoryAbsolute === 0) continue;
    const percentage = (categoryAbsolute / totalAbsolute) * 100;

    stats.push({
      statType: StatType.CategoryBreakdown,
      category,
      value: sum(group.amounts),
      sampleSize: group.amounts.length,
      details: {
        percentage,
        absoluteTotal: categoryAbsolute,
        transactionCount: group.amounts.length,
        min: min(group.amounts),
        max: max(group.amounts),
      },
    });
  }

  return stats;
}
