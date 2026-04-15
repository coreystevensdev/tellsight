const currencyFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(value: number): string {
  return currencyFull.format(value);
}

export function formatAbbreviated(value: number): string {
  if (value === 0) return '$0';

  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return currencyFull.format(value);
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${Math.round(value)}%`;
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

