import { eq, asc } from 'drizzle-orm';
import type { ChartFilters } from 'shared/types';
import { db } from '../../lib/db.js';
import { dataRows } from '../schema.js';

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isInDateRange(rowDate: Date, from?: Date, to?: Date): boolean {
  const d = toISODate(rowDate);
  if (from && d < toISODate(from)) return false;
  if (to && d > toISODate(to)) return false;
  return true;
}

/**
 * Aggregates an org's data_rows into chart-ready structures.
 *
 * Metadata (availableCategories, dateRange) always reflects the full dataset
 * so filter controls show all options regardless of current filter state.
 * Actual chart data is filtered by the provided params.
 *
 * Runs a single query, filters + aggregates in JS. Good enough for <50k rows;
 * move to SQL GROUP BY if this becomes a bottleneck.
 */
export async function getChartData(orgId: number, filters?: ChartFilters) {
  const rows = await db.query.dataRows.findMany({
    where: eq(dataRows.orgId, orgId),
    orderBy: asc(dataRows.date),
  });

  // metadata from full dataset — available options for the filter UI
  const categorySet = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of rows) {
    if (row.parentCategory === 'Expenses') {
      categorySet.add(row.category);
    }
    if (!minDate || row.date < minDate) minDate = row.date;
    if (!maxDate || row.date > maxDate) maxDate = row.date;
  }

  const availableCategories = [...categorySet].sort();
  const dateRange = minDate && maxDate
    ? { min: toISODate(minDate), max: toISODate(maxDate) }
    : null;

  // filtered aggregation
  const activeCategories = filters?.categories?.length
    ? new Set(filters.categories)
    : null;

  const revenueByMonth = new Map<string, number>();
  const expenseTotals = new Map<string, number>();

  for (const row of rows) {
    if (!isInDateRange(row.date, filters?.dateFrom, filters?.dateTo)) continue;

    const amount = parseFloat(row.amount);

    if (row.parentCategory === 'Income') {
      const key = `${row.date.getFullYear()}-${String(row.date.getMonth() + 1).padStart(2, '0')}`;
      revenueByMonth.set(key, (revenueByMonth.get(key) ?? 0) + amount);
    } else if (row.parentCategory === 'Expenses') {
      if (activeCategories && !activeCategories.has(row.category)) continue;
      expenseTotals.set(row.category, (expenseTotals.get(row.category) ?? 0) + amount);
    }
  }

  const revenueTrend = [...revenueByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, revenue]) => {
      const monthIdx = parseInt(key.split('-')[1]!, 10) - 1;
      const year = key.split('-')[0];
      return {
        month: `${MONTH_LABELS[monthIdx]} ${year}`,
        revenue: Math.round(revenue * 100) / 100,
      };
    });

  const expenseBreakdown = [...expenseTotals.entries()]
    .map(([category, total]) => ({ category, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);

  return { revenueTrend, expenseBreakdown, availableCategories, dateRange };
}
