export { formatAbbreviated, formatPercent } from 'shared/formatting';

const currencyFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(value: number): string {
  return currencyFull.format(value);
}

export function computeTrend(data: { revenue: number }[]): number | null {
  if (data.length < 2) return null;

  const last = data[data.length - 1]!.revenue;

  // prefer YoY (same month last year) over consecutive-month comparison
  if (data.length >= 13) {
    const sameMonthLastYear = data[data.length - 13]!.revenue;
    if (sameMonthLastYear > 0) return ((last - sameMonthLastYear) / sameMonthLastYear) * 100;
  }

  const prev = data[data.length - 2]!.revenue;
  if (prev === 0) return last > 0 ? 100 : last < 0 ? -100 : 0;
  return ((last - prev) / prev) * 100;
}

