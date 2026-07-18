// Mirrors apps/web/app/dashboard/charts/formatters.ts's abbreviation rules.
// Not imported directly: apps/api can't import from apps/web, and these
// charts render server-side with no shared runtime with the browser bundle.
const currencyFull = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

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
