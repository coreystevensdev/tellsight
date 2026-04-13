'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface ExpenseTrendChartProps {
  data: Array<Record<string, string | number>>;
  categories: string[];
}

const AREA_COLORS = [
  'var(--color-chart-expense-1)',
  'var(--color-chart-expense-2)',
  'var(--color-chart-expense-3)',
  'var(--color-chart-expense-4)',
  'var(--color-chart-expense-5)',
  'var(--color-chart-expense-6)',
];

function TrendTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  const total = payload.reduce((sum, p) => sum + (p.value ?? 0), 0);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="mb-1.5 font-medium text-card-foreground">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: p.color }}
            />
            <span className="text-muted-foreground">{p.name}</span>
          </span>
          <span className="font-medium text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
            {formatCurrency(p.value)}
          </span>
        </div>
      ))}
      <div className="mt-1.5 border-t border-border pt-1.5 text-right font-semibold text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
        {formatCurrency(total)}
      </div>
    </div>
  );
}

export function ExpenseTrendChart({ data, categories }: ExpenseTrendChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length === 0) return null;

  return (
    <figure className="card-hover rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">
          Expense Trend
        </h3>
      </figcaption>

      <div
        className="aspect-[2.5/1]"
        role="img"
        aria-label={`Stacked area chart showing monthly expense trends across ${categories.length} categories`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <AreaChart
            data={data}
            title="Monthly expense trends by category"
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
            <Tooltip content={<TrendTooltip />} />
            {categories.map((cat, i) => (
              <Area
                key={cat}
                type="monotone"
                dataKey={cat}
                stackId="expenses"
                fill={AREA_COLORS[i % AREA_COLORS.length]}
                stroke={AREA_COLORS[i % AREA_COLORS.length]}
                fillOpacity={0.6}
                strokeWidth={1.5}
                animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
                animationEasing={CHART_CONFIG.ANIMATION_EASING}
                isAnimationActive={!reducedMotion}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
