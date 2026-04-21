'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
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
  variant?: 'full' | 'thumbnail';
}

function BalanceTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.[0]) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{label}</p>
      <p className="font-semibold text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
        {formatCurrency(payload[0].value)}
      </p>
    </div>
  );
}

export function RunwayTrendChart({ data, variant = 'full' }: RunwayTrendChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length < 2) {
    // single snapshot can't trend; this is the new-user case until they
    // update their cash balance a second time (Story 8.2 ships the field,
    // 8.5 ships the chart that needs at least two points to plot)
    return (
      <div
        role="status"
        className="flex h-full min-h-[120px] items-center justify-center rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      >
        More history needed to trend your cash balance.
      </div>
    );
  }

  // recharts plots in array order; cash-history endpoint returns newest-first,
  // so reverse for left-to-right time progression
  const series = [...data].reverse().map((p) => ({
    label: p.asOfDate.slice(0, 10),
    balance: p.balance,
  }));

  const isThumbnail = variant === 'thumbnail';

  if (isThumbnail) {
    return (
      <div className="h-full w-full" role="img" aria-label="Cash balance over time">
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart data={series} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
            <Line
              type="monotone"
              dataKey="balance"
              stroke="var(--color-chart-revenue)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <figure className="rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">Cash balance over time</h3>
      </figcaption>
      <div className="aspect-video" role="img" aria-label="Line chart showing cash balance over time">
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart data={series} margin={{ top: 5, right: 20, bottom: 5, left: 0 }} accessibilityLayer>
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
            <Line
              type="monotone"
              dataKey="balance"
              stroke="var(--color-chart-revenue)"
              strokeWidth={2}
              dot={{ r: 4, fill: 'var(--color-chart-revenue-dot)', stroke: 'var(--color-background)', strokeWidth: 2 }}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
