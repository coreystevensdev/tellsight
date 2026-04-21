'use client';

import { BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getStatChartConfig } from './charts/statChartMap';
import { RunwayTrendChart, type CashBalancePoint } from './charts/RunwayTrendChart';

export interface InsightChartThumbnailProps {
  statId: string;
  cashHistory?: CashBalancePoint[];
  cashForecast?: CashBalancePoint[];
  onOpen: () => void;
  className?: string;
}

// Inline thumbnail rendered next to a tagged paragraph on desktop. Click
// opens the drill-down sheet (Task 9). Returns null for unmapped stats so
// the paragraph renders prose-only — by design, not a bug. Runway and
// cash-forecast both get the real RunwayTrendChart at thumbnail size; the
// other mapped stats get a chart-icon affordance that fills the same 180×120
// slot until per-stat thumbnail variants ship in a follow-up.
export function InsightChartThumbnail({
  statId,
  cashHistory,
  cashForecast,
  onOpen,
  className,
}: InsightChartThumbnailProps) {
  const config = getStatChartConfig(statId);
  if (!config) return null;

  const accessibleName = `Open ${config.label} drill-down`;
  // Delegate empty-state handling to RunwayTrendChart itself — it renders
  // "more history needed" when both data and forecast are empty.
  const showRunwayChart =
    (statId === 'runway' || statId === 'cash_forecast') && (cashHistory !== undefined || cashForecast !== undefined);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={accessibleName}
      className={cn(
        'group relative flex h-[120px] w-[180px] flex-shrink-0 cursor-pointer flex-col overflow-hidden rounded-lg border border-border bg-card p-2 text-left shadow-sm transition-colors duration-200 ease-out hover:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/40',
        className,
      )}
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <BarChart3 className="h-3 w-3" aria-hidden="true" />
        <span className="truncate">{config.label}</span>
      </div>
      <div className="flex-1">
        {showRunwayChart ? (
          <RunwayTrendChart
            data={cashHistory ?? []}
            forecast={cashForecast}
            variant="thumbnail"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
            Tap to open chart
          </div>
        )}
      </div>
    </button>
  );
}
