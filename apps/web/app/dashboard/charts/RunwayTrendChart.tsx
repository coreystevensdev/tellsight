'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

export interface CashBalancePoint {
  balance: number;
  asOfDate: string;
}

interface RunwayTrendChartProps {
  data: CashBalancePoint[];
  forecast?: CashBalancePoint[];
  variant?: 'full' | 'thumbnail';
}

interface SeriesRow {
  label: string;
  historical: number | null;
  projected: number | null;
}

function BalanceTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload.find((p) => p.value != null);
  if (!point) return null;
  const isProjected = point.dataKey === 'projected';
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{label}</p>
      <p className="font-semibold text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
        {formatCurrency(point.value)}
        {isProjected ? ' (projected)' : ''}
      </p>
    </div>
  );
}

export function RunwayTrendChart({ data, forecast, variant = 'full' }: RunwayTrendChartProps) {
  const reducedMotion = useReducedMotion();

  // `hasHistoricalLine` gates whether we can draw a solid historical line —
  // needs ≥2 points to form a segment. A single historical point still
  // participates via the bridge into the forecast segment; it just doesn't
  // stand on its own. `hasForecast` requires ≥1 projected point.
  const hasHistoricalLine = data.length >= 2;
  const hasForecast = (forecast?.length ?? 0) >= 1;

  if (!hasHistoricalLine && !hasForecast) {
    // single snapshot can't trend and no forecast to project from — same
    // empty state 8.2 shipped, widened to cover the "no forecast either" case
    return (
      <div
        role="status"
        className="flex h-full min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      >
        More history needed to trend your cash balance.
      </div>
    );
  }

  // cash-history endpoint returns newest-first; forecast is already chronological
  const historicalSorted = [...data].reverse();
  const forecastSorted = forecast ?? [];
  const lastHistorical = historicalSorted[historicalSorted.length - 1];

  const combined: SeriesRow[] = [
    ...historicalSorted.map((p) => ({
      label: p.asOfDate.slice(0, 10),
      historical: p.balance,
      projected: null as number | null,
    })),
    ...forecastSorted.map((p) => ({
      label: p.asOfDate.slice(0, 10),
      historical: null as number | null,
      projected: p.balance,
    })),
  ];

  // bridge: mark the last historical row with projected = same balance so
  // the dashed line starts at the handoff. connectNulls on the projected line
  // stitches across the transition.
  if (lastHistorical && forecastSorted.length > 0) {
    const bridge = combined.find((c) => c.label === lastHistorical.asOfDate.slice(0, 10));
    if (bridge) bridge.projected = lastHistorical.balance;
  }

  const isThumbnail = variant === 'thumbnail';

  if (isThumbnail) {
    return (
      <div className="h-full w-full" role="img" aria-label="Cash balance over time">
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart data={combined} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Line
              type="monotone"
              dataKey="historical"
              stroke="var(--color-chart-revenue)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
            {hasForecast && (
              <Line
                type="monotone"
                dataKey="projected"
                stroke="var(--color-chart-revenue)"
                strokeWidth={2}
                strokeDasharray="3 3"
                connectNulls
                dot={false}
                isAnimationActive={!reducedMotion}
                animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <figure className="rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">
          {hasForecast ? 'Cash balance — history and forecast' : 'Cash balance over time'}
        </h3>
      </figcaption>
      <div
        className="aspect-video"
        role="img"
        aria-label={
          hasForecast
            ? 'Line chart showing cash balance over time with a dashed three-month projection'
            : 'Line chart showing cash balance over time'
        }
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart data={combined} margin={{ top: 5, right: 20, bottom: 5, left: 0 }} accessibilityLayer>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fontWeight: 500 }}
              className="fill-muted-foreground"
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatAbbreviated}
              tick={{ fontSize: 12, fontWeight: 500 }}
              className="fill-muted-foreground"
              tickLine={false}
              axisLine={false}
              width={55}
            />
            <Tooltip content={<BalanceTooltip />} />
            {hasHistoricalLine && hasForecast && lastHistorical && (
              <ReferenceLine
                x={lastHistorical.asOfDate.slice(0, 10)}
                stroke="var(--color-border)"
                strokeDasharray="2 2"
              />
            )}
            <Line
              type="monotone"
              dataKey="historical"
              stroke="var(--color-chart-revenue)"
              strokeWidth={2}
              dot={{ r: 4, fill: 'var(--color-chart-revenue-dot)', stroke: 'var(--color-background)', strokeWidth: 2 }}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
            {hasForecast && (
              <Line
                type="monotone"
                dataKey="projected"
                stroke="var(--color-chart-revenue)"
                strokeWidth={2}
                strokeDasharray="4 4"
                connectNulls
                dot={{ r: 3, fill: 'var(--color-background)', stroke: 'var(--color-chart-revenue-dot)', strokeWidth: 2 }}
                isAnimationActive={!reducedMotion}
                animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
