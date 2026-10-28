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
      details: { scope: 'overall', median: overallMedian },
    });
  }

  return stats;
}

export function computeCategoryBreakdowns(
  groups: Map<string, CategoryGroup>,
): ComputedStat[] {
  const stats: ComputedStat[] = [];

  let totalAbsolute = 0;
  for (const group of groups.values()) {
    totalAbsolute += group.amounts.reduce((total, amount) => total + Math.abs(amount), 0);
  }

  if (totalAbsolute === 0) return stats;

  for (const [category, group] of groups) {
    const categoryAbsolute = group.amounts.reduce(
      (total, amount) => total + Math.abs(amount),
      0,
    );
    const percentage = (categoryAbsolute / totalAbsolute) * 100;

    stats.push({
      statType: StatType.CategoryBreakdown,
      category,
      value: sum(group.amounts),
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
