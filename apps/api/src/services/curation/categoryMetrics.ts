import type { CategoryPlan } from 'shared/types';

import {
  financialEffect,
  isExplicitlyNonFinancial,
  monthKey,
  parseAmount,
  type DataRow,
} from './computationPrimitives.js';
import type { CategoryVarianceStat } from './types.js';
import { StatType } from './types.js';

export interface CategoryGroup {
  amounts: number[];
  timeSeries: [number, number][];
  // Index-aligned with amounts, the way timeSeries already is: -1 where the row
  // was a contra entry, +1 otherwise. Kept as a third array rather than folded
  // into amounts so every consumer that has not been taught about contra
  // entries reads exactly what it read before, which is the property that lets
  // them be taught one at a time.
  signs: (1 | -1)[];
}

// The contribution each row makes to its category's net, contra entries
// subtracting. A negative amount that is not a contra entry stays negative:
// that is a bank export storing its own sign (normalizer.ts), not a reduction.
export function netAmounts(group: CategoryGroup): number[] {
  return group.amounts.map((amount, index) => (group.signs[index] ?? 1) * amount);
}

export function groupByCategory(rows: DataRow[]): Map<string, CategoryGroup> {
  const groups = new Map<string, CategoryGroup>();

  for (const row of rows) {
    // DW-232: every other consumer of these rows drops a classified non-P&L
    // figure and this one did not, so a balance-sheet number was summed into a
    // category total. Measured on production before the fix: 26 Shopify product
    // rows carrying $547,724.80 of inventory value, which computeTotals
    // reported as category totals beside real revenue while every chart ignored
    // them. computeCategoryBreakdowns and computeCategoryVariance read these
    // same groups, so all three were wrong together.
    if (isExplicitlyNonFinancial(row)) continue;

    const amount = parseAmount(row.amount);
    if (amount === null) continue;

    let group = groups.get(row.category);
    if (!group) {
      group = { amounts: [], timeSeries: [], signs: [] };
      groups.set(row.category, group);
    }

    group.amounts.push(amount);
    group.timeSeries.push([row.date.getTime(), amount]);
    group.signs.push(financialEffect(row)?.sign ?? 1);
  }

  return groups;
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
    for (const [timestamp] of group.timeSeries) {
      months.add(monthKey(new Date(timestamp)));
    }
  }

  // < not !==: a forecast row or a typo'd future date must not win this,
  // either. !== alone would let it through and compare a real plan against
  // a month that hasn't happened, reporting every category wildly under.
  const completeMonths = [...months].filter((month) => month < currentMonth).sort();
  const targetMonth = completeMonths[completeMonths.length - 1];
  if (!targetMonth) return [];

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
    let transactionCount = 0;
    if (group) {
      // abs() because the plan the owner typed is nonnegative and a bank export
      // can store an expense as a negative; the sign then reinstates a contra
      // entry's reduction, which abs() would otherwise have turned into spend.
      group.timeSeries.forEach(([timestamp, amount], index) => {
        if (monthKey(new Date(timestamp)) === targetMonth) {
          actualMonthly += (group.signs[index] ?? 1) * Math.abs(amount);
          transactionCount++;
        }
      });
    }

    const variance = actualMonthly - plan.plannedMonthly;
    // A zero plan has no percentage to report. Guard rather than emit Infinity,
    // which validateSummary would then have to recognise as not-a-figure.
    const variancePercent =
      plan.plannedMonthly === 0 ? 0 : (variance / plan.plannedMonthly) * 100;
    const direction =
      Math.abs(variancePercent) < 5 ? 'on_plan' : variance > 0 ? 'over' : 'under';

    stats.push({
      statType: StatType.CategoryVariance,
      category: plan.category,
      value: variance,
      sampleSize: transactionCount,
      details: {
        plannedMonthly: plan.plannedMonthly,
        actualMonthly,
        variance,
        variancePercent: Math.round(variancePercent * 10) / 10,
        monthLabel: targetMonth,
        direction,
      },
    });
  }

  return stats;
}
