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
import type { RevenueTrendPoint } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated, computeTrend } from './formatters';
import { TrendBadge } from './TrendBadge';

interface RevenueChartProps {
  data: RevenueTrendPoint[];
}

export function RevenueTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.[0]) return null;

  const value = payload[0].value;
  const display = value == null ? 'No data for this period' : formatCurrency(value);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{label}</p>
      <p
        className={value == null ? 'text-muted-foreground' : 'font-semibold text-card-foreground'}
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {display}
      </p>
    </div>
  );
}

export function RevenueChart({ data }: RevenueChartProps) {
  const reducedMotion = useReducedMotion();
  const trend = computeTrend(data);
  const lastPoint = data[data.length - 1];
  const lastValue = lastPoint?.revenue ?? 0;
  const lastMonth = lastPoint?.month ?? '';

  return (
    <figure className="card-hover rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-card-foreground">
          Revenue Trend
        </h3>
        <TrendBadge value={trend} label="Revenue" />
      </figcaption>

      <div
        className="aspect-video"
        role="img"
        aria-label={`Line chart showing monthly revenue trend${lastPoint ? `, most recent ${lastMonth} at ${formatCurrency(lastValue)}` : ''}`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart
            data={data}
            title="Monthly revenue trend"
            margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.01em' }}
              className="fill-muted-foreground"
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tickFormatter={formatAbbreviated}
              tick={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.01em' }}
              className="fill-muted-foreground"
              tickLine={false}
              axisLine={false}
              width={55}
            />
            <Tooltip content={<RevenueTooltip />} />
            <Line
              type="monotone"
              dataKey="revenue"
              strokeWidth={2}
              stroke="var(--color-chart-revenue)"
              dot={{ r: 4, fill: 'var(--color-chart-revenue-dot)', stroke: 'var(--color-background)', strokeWidth: 2 }}
              activeDot={{ r: 6, fill: 'var(--color-chart-revenue-dot)', stroke: 'var(--color-background)', strokeWidth: 2 }}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              animationEasing={CHART_CONFIG.ANIMATION_EASING}
              isAnimationActive={!reducedMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 text-sm text-muted-foreground" style={{ fontFeatureSettings: '"tnum"', lineHeight: '1.5' }}>
        {lastValue === 0 ? (
          <span className="text-muted-foreground">$0</span>
        ) : (
          <span>{formatCurrency(lastValue)}</span>
        )} in {lastMonth || 'latest period'}
      </div>
    </figure>
  );
}
