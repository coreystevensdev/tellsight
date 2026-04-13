'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { MonthlyComparisonPoint } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface ProfitMarginChartProps {
  data: MonthlyComparisonPoint[];
}

function ProfitTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number }>;
  label?: string;
}) {
  if (!active || !payload?.[0]) return null;

  const profit = payload[0].value;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{label}</p>
      <p
        className={profit >= 0 ? 'font-semibold text-success' : 'font-semibold text-destructive'}
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {profit >= 0 ? '+' : ''}{formatCurrency(profit)}
      </p>
    </div>
  );
}

export function ProfitMarginChart({ data }: ProfitMarginChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length === 0) return null;

  return (
    <figure className="card-hover rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">
          Monthly Profit
        </h3>
      </figcaption>

      <div
        className="aspect-video"
        role="img"
        aria-label="Area chart showing monthly profit (revenue minus expenses)"
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <AreaChart
            data={data}
            margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="month"
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
            <Tooltip content={<ProfitTooltip />} />
            <ReferenceLine y={0} stroke="var(--color-border)" strokeDasharray="3 3" />
            <Area
              type="monotone"
              dataKey="profit"
              stroke="var(--color-success)"
              fill="var(--color-success)"
              fillOpacity={0.15}
              strokeWidth={2}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              isAnimationActive={!reducedMotion}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
