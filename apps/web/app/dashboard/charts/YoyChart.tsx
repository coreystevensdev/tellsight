'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { YoyComparisonPoint } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface YoyChartProps {
  data: YoyComparisonPoint[];
}

function YoyTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; fill: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  const prior = payload[0]?.value ?? 0;
  const current = payload[1]?.value ?? 0;
  const change = prior > 0 ? ((current - prior) / prior) * 100 : null;

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
              style={{ backgroundColor: p.fill }}
            />
            <span className="text-muted-foreground">{p.name}</span>
          </span>
          <span className="font-medium text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
            {formatCurrency(p.value)}
          </span>
        </div>
      ))}
      {change !== null && (
        <div className="mt-1.5 border-t border-border pt-1.5 text-right">
          <span
            className={`text-xs font-semibold ${change >= 0 ? 'text-success' : 'text-destructive'}`}
            style={{ fontFeatureSettings: '"tnum"' }}
          >
            {change >= 0 ? '+' : ''}{change.toFixed(1)}% YoY
          </span>
        </div>
      )}
    </div>
  );
}

export function YoyChart({ data }: YoyChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length === 0) return null;

  const currentLabel = data[0]?.currentYearLabel ?? '';
  const priorLabel = data[0]?.priorYearLabel ?? '';

  const chartData = data.map((d) => ({
    month: d.month,
    [currentLabel]: d.currentYear,
    [priorLabel]: d.priorYear,
  }));

  return (
    <figure className="border-t-2 border-border bg-card p-4 transition-colors duration-200 ease-out hover:border-primary md:p-6">
      <figcaption className="mb-4">
        <h3 className="font-serif text-lg font-medium text-card-foreground">
          Year-over-Year Revenue
        </h3>
      </figcaption>

      <div
        className="aspect-[2.5/1]"
        role="img"
        aria-label={`Grouped bar chart comparing revenue in ${priorLabel} and ${currentLabel} by month`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <BarChart
            data={chartData}
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
            <Tooltip content={<YoyTooltip />} />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            />
            <Bar
              dataKey={priorLabel}
              name={priorLabel}
              fill="var(--color-chart-expense-2)"
              radius={[4, 4, 0, 0]}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              isAnimationActive={!reducedMotion}
            />
            <Bar
              dataKey={currentLabel}
              name={currentLabel}
              fill="var(--color-chart-revenue)"
              radius={[4, 4, 0, 0]}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              isAnimationActive={!reducedMotion}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
