import { mean } from 'simple-statistics';

import { MONTH_NAMES, parseAmount, type DataRow } from './computationPrimitives.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

function groupRevenueByYearMonth(rows: DataRow[]): Map<number, Map<number, number>> {
  const revenueByYearMonth = new Map<number, Map<number, number>>();

  for (const row of rows) {
    if (row.parentCategory !== 'Income') continue;
    const amount = parseAmount(row.amount);
    if (amount === null) continue;

    const year = row.date.getUTCFullYear();
    const month = row.date.getUTCMonth();
    if (!revenueByYearMonth.has(year)) revenueByYearMonth.set(year, new Map());
    const yearMonths = revenueByYearMonth.get(year)!;
    yearMonths.set(month, (yearMonths.get(month) ?? 0) + amount);
  }

  return revenueByYearMonth;
}

export function computeYearOverYear(rows: DataRow[]): ComputedStat[] {
  const revenueByYearMonth = groupRevenueByYearMonth(rows);
  const years = [...revenueByYearMonth.keys()].sort();
  if (years.length < 2) return [];

  const currentYear = years[years.length - 1]!;
  const priorYear = years[years.length - 2]!;
  const currentMap = revenueByYearMonth.get(currentYear)!;
  const priorMap = revenueByYearMonth.get(priorYear)!;

  const stats: ComputedStat[] = [];

  for (const [month, current] of currentMap) {
    const prior = priorMap.get(month);
    if (!prior || prior === 0) continue;

    const changePercent = ((current - prior) / prior) * 100;
    if (Math.abs(changePercent) < 3) continue;

    stats.push({
      statType: StatType.YearOverYear,
      category: 'Revenue',
      value: current,
      comparison: prior,
      details: {
        currentRevenue: current,
        priorRevenue: prior,
        currentYearLabel: String(currentYear),
        priorYearLabel: String(priorYear),
        changePercent: Math.round(changePercent * 10) / 10,
        month: MONTH_NAMES[month]!,
      },
    });
  }

  return stats;
}

export function computeSeasonalProjection(rows: DataRow[]): ComputedStat[] {
  const revenueByYearMonth = groupRevenueByYearMonth(rows);
  const years = [...revenueByYearMonth.keys()].sort();
  if (years.length < 2) return [];

  const latestYear = years[years.length - 1]!;
  const latestMonths = [...(revenueByYearMonth.get(latestYear)?.keys() ?? [])].sort(
    (a, b) => a - b,
  );
  if (latestMonths.length === 0) return [];

  const lastMonth = latestMonths[latestMonths.length - 1]!;
  const nextMonth = (lastMonth + 1) % 12;
  const nextYear = nextMonth === 0 ? latestYear + 1 : latestYear;

  const basisValues: number[] = [];
  const basisMonths: string[] = [];
  for (const year of years) {
    const value = revenueByYearMonth.get(year)?.get(nextMonth);
    if (value !== undefined) {
      basisValues.push(value);
      basisMonths.push(`${MONTH_NAMES[nextMonth]} ${year}`);
    }
  }

  if (basisValues.length === 0) return [];

  const previousYear = years[years.length - 2]!;
  const currentTotal = [...(revenueByYearMonth.get(latestYear)?.values() ?? [])].reduce(
    (total, value) => total + value,
    0,
  );
  const previousTotal = [...(revenueByYearMonth.get(previousYear)?.values() ?? [])].reduce(
    (total, value) => total + value,
    0,
  );
  const latestYearGrowth = previousTotal > 0 ? (currentTotal - previousTotal) / previousTotal : 0;

  const baseProjection = mean(basisValues);
  const projected = Math.round(baseProjection * (1 + latestYearGrowth));
  const confidence =
    basisValues.length >= 3 ? 'high' : basisValues.length === 2 ? 'moderate' : 'low';

  return [
    {
      statType: StatType.SeasonalProjection,
      category: 'Revenue',
      value: projected,
      details: {
        projectedMonth: `${MONTH_NAMES[nextMonth]} ${nextYear}`,
        projectedAmount: projected,
        basisMonths,
        basisValues,
        confidence,
      },
    },
  ];
}
