'use client';

import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { getStatChartConfig } from './charts/statChartMap';
import { RunwayTrendChart, type CashBalancePoint } from './charts/RunwayTrendChart';

export interface StatDetailPair {
  label: string;
  value: string;
}

export interface InsightChartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statId: string | null;
  paragraphText?: string;
  cashHistory?: CashBalancePoint[];
  cashForecast?: CashBalancePoint[];
  details?: StatDetailPair[];
}

export function InsightChartSheet({
  open,
  onOpenChange,
  statId,
  paragraphText,
  cashHistory,
  cashForecast,
  details,
}: InsightChartSheetProps) {
  const isMobile = useIsMobile();
  const config = statId ? getStatChartConfig(statId) : null;

  // sheet stays mounted during transition; nothing to render until a binding opens it
  if (!config) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={isMobile ? 'h-[85vh] rounded-t-xl' : 'sm:max-w-lg'}
      >
        <SheetTitle>{config.label}</SheetTitle>
        <SheetDescription className="sr-only">
          Drill-down view for the chart that backs the highlighted insight.
        </SheetDescription>

        <div className="mt-4 flex flex-col gap-6 overflow-y-auto px-4 pb-6">
          {paragraphText && (
            <blockquote className="border-l-2 border-primary/40 pl-3 text-sm italic text-muted-foreground">
              {paragraphText}
            </blockquote>
          )}

          <div className="min-h-[220px]">
            {(statId === 'runway' || statId === 'cash_forecast') && (cashHistory || cashForecast) ? (
              <RunwayTrendChart
                data={cashHistory ?? []}
                forecast={cashForecast}
                variant="full"
              />
            ) : (
              <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Open the dashboard to view the full {config.label.toLowerCase()} chart.
              </div>
            )}
          </div>

          {details && details.length > 0 && (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              {details.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium tabular-nums text-card-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
