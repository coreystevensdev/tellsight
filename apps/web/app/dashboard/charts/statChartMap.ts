// Single source of truth for stat-ID -> chart binding. Used by
// InsightChartThumbnail (inline render next to a paragraph) and
// InsightChartSheet (drill-down). Stats absent from this map render
// prose-only, no chip, no thumbnail. Adding a new stat-chart pairing
// means adding an entry here and nothing else.
//
// CRITICAL: do NOT call STAT_CHART_MAP[id] without nullish-checking. The
// type is Partial<Record<...>>; unmapped IDs return undefined and silent
// null is the correct render path.

export type MappedStatId =
  | 'runway'
  | 'cash_flow'
  | 'cash_forecast'
  | 'margin_trend'
  | 'year_over_year'
  | 'trend';

export interface StatChartConfig {
  label: string;
  // Lazy import path (string) so the bundler can split chart code per stat.
  // Resolved by InsightChartThumbnail/Sheet at render time. Keeping the
  // mapping data-only (no React component imports) prevents this file from
  // forcing every chart into the initial bundle.
  thumbnailComponent: 'RunwayTrendChart' | 'RevenueVsExpensesChart' | 'ProfitMarginChart' | 'YoyChart' | 'RevenueChart';
}

export const STAT_CHART_MAP: Record<MappedStatId, StatChartConfig> = {
  runway: { label: 'Cash balance over time', thumbnailComponent: 'RunwayTrendChart' },
  cash_flow: { label: 'Revenue vs. expenses', thumbnailComponent: 'RevenueVsExpensesChart' },
  cash_forecast: { label: 'Cash balance trajectory', thumbnailComponent: 'RunwayTrendChart' },
  margin_trend: { label: 'Profit margin trend', thumbnailComponent: 'ProfitMarginChart' },
  year_over_year: { label: 'Year-over-year', thumbnailComponent: 'YoyChart' },
  trend: { label: 'Revenue trend', thumbnailComponent: 'RevenueChart' },
};

export function getStatChartConfig(statId: string): StatChartConfig | null {
  return statId in STAT_CHART_MAP ? STAT_CHART_MAP[statId as MappedStatId] : null;
}
