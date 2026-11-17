import { financialEffect, monthKey, parseAmount, type DataRow } from './computationPrimitives.js';
import type { TaxSetAsideStat } from './types.js';
import { StatType } from './types.js';

/**
 * How much of the period's profit is already owed to someone else.
 *
 * This is arithmetic on two numbers the owner supplied or earned: their own
 * stated rate against their own net profit. It is deliberately not a tax
 * calculation. No jurisdiction is looked up, no rate is inferred, no filing
 * frequency is assumed, and nothing is recommended. The product's standing rule
 * is never "you should", and a rate the product chose would be exactly that,
 * so an absent rate suppresses the stat rather than defaulting it (DW-284).
 *
 * Suppressed when:
 *   - no rate has been supplied, because guessing one is advice
 *   - the period is at or below break-even, because there is no profit to owe
 *     tax on and "set aside $0" is noise dressed as an insight
 *   - fewer than two months of activity, because one month of profit says
 *     nothing about what the period will owe
 */
export function computeTaxSetAside(
  rows: DataRow[],
  taxSetAsidePercent: number | null | undefined,
): TaxSetAsideStat[] {
  if (taxSetAsidePercent == null || taxSetAsidePercent <= 0) return [];

  const months = new Set<string>();
  let revenue = 0;
  let expenses = 0;

  for (const row of rows) {
    const amount = parseAmount(row.amount);
    if (amount === null) continue;
    const effect = financialEffect(row);
    if (!effect) continue;

    months.add(monthKey(row.date));
    if (effect.side === 'Income') revenue += effect.sign * amount;
    else expenses += effect.sign * amount;
  }

  const monthsCovered = months.size;
  if (monthsCovered < 2) return [];

  // Zero revenue is a dataset that classified nothing, which is a different
  // condition from a real month that lost money.
  if (revenue <= 0) return [];

  const netProfit = revenue - expenses;
  const setAside = Math.round(netProfit * (taxSetAsidePercent / 100));

  // One guard, not two. A `netProfit <= 0` check here would be strictly
  // subsumed: a loss times a positive rate is negative, so this catches it
  // anyway. This also catches the case that one would miss, a profit so small
  // the set-aside rounds to nothing, and "set aside $0" is noise dressed as an
  // insight either way.
  if (setAside <= 0) return [];

  return [
    {
      statType: StatType.TaxSetAside,
      category: null,
      value: setAside,
      // Months, not rows: the figure is a period total, and its weakness is a
      // short period rather than a thin sample within one.
      sampleSize: monthsCovered,
      details: {
        netProfit: Math.round(netProfit),
        ratePercent: taxSetAsidePercent,
        setAside,
        monthsCovered,
        revenue: Math.round(revenue),
        expenses: Math.round(expenses),
      },
    },
  ];
}
