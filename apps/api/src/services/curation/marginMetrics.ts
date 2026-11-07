import { financialEffect, monthKey, parseAmount, type DataRow } from './computationPrimitives.js';
import type { MarginTrendStat } from './types.js';
import { StatType } from './types.js';

// Recent/prior month split for margin trend analysis: the trailing half of
// months with Income or Expenses activity vs. the leading half. Exported so
// source-row resolution can recompute the same window without duplicating it.
export function marginTrendMonths(
  rows: DataRow[],
): { recentMonths: string[]; priorMonths: string[] } | null {
  const months = new Set<string>();
  for (const row of rows) {
    const amount = parseAmount(row.amount);
    if (amount === null) continue;
    if (financialEffect(row) !== null) {
      months.add(monthKey(row.date));
    }
  }

  const sorted = [...months].sort();
  if (sorted.length < 4) return null;

  const half = Math.floor(sorted.length / 2);
  return { recentMonths: sorted.slice(half), priorMonths: sorted.slice(0, half) };
}

export function computeMarginTrend(rows: DataRow[]): MarginTrendStat[] {
  const revenueByMonth = new Map<string, number>();
  const expenseByMonth = new Map<string, number>();

  for (const row of rows) {
    const amount = parseAmount(row.amount);
    if (amount === null) continue;

    const key = monthKey(row.date);
    const effect = financialEffect(row);
    if (effect?.side === 'Income') {
      revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + effect.sign * amount);
    } else if (effect?.side === 'Expenses') {
      expenseByMonth.set(key, (expenseByMonth.get(key) ?? 0) + effect.sign * amount);
    }
  }

  const monthSplit = marginTrendMonths(rows);
  if (!monthSplit) return [];
  const { recentMonths, priorMonths } = monthSplit;

  const recentRevenue = recentMonths.reduce(
    (total, month) => total + (revenueByMonth.get(month) ?? 0),
    0,
  );
  const recentExpense = recentMonths.reduce(
    (total, month) => total + (expenseByMonth.get(month) ?? 0),
    0,
  );
  const priorRevenue = priorMonths.reduce(
    (total, month) => total + (revenueByMonth.get(month) ?? 0),
    0,
  );
  const priorExpense = priorMonths.reduce(
    (total, month) => total + (expenseByMonth.get(month) ?? 0),
    0,
  );

  if (recentRevenue === 0 || priorRevenue === 0) return [];

  const recentMargin = ((recentRevenue - recentExpense) / recentRevenue) * 100;
  const priorMargin = ((priorRevenue - priorExpense) / priorRevenue) * 100;
  const difference = recentMargin - priorMargin;

  const direction =
    Math.abs(difference) < 2 ? 'stable' : difference > 0 ? 'expanding' : 'shrinking';

  const revenueGrowth = ((recentRevenue - priorRevenue) / priorRevenue) * 100;
  const expenseGrowth = ((recentExpense - priorExpense) / priorExpense) * 100;

  return [
    {
      statType: StatType.MarginTrend,
      category: null,
      value: recentMargin,
      comparison: priorMargin,
      // The thinner of the two windows, not their sum. marginTrendMonths
      // splits into floor/ceil halves, so the sum always collapses back to
      // sorted.length -- a 6-month dataset split 3-and-3 would report 6, and a
      // comparison is no stronger than its thinner side.
      sampleSize: Math.min(recentMonths.length, priorMonths.length),
      details: {
        recentMarginPercent: Math.round(recentMargin * 10) / 10,
        priorMarginPercent: Math.round(priorMargin * 10) / 10,
        direction,
        revenueGrowthPercent: Math.round(revenueGrowth * 10) / 10,
        expenseGrowthPercent: Math.round(expenseGrowth * 10) / 10,
      },
    },
  ];
}
