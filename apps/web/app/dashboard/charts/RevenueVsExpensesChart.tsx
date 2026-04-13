'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import type { MonthlyComparisonPoint } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface RevenueVsExpensesChartProps {
  data: MonthlyComparisonPoint[];
}

function ComparisonTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;

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
    </div>
  );
}

export function RevenueVsExpensesChart({ data }: RevenueVsExpensesChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length === 0) return null;

  return (
    <figure className="rounded-lg border border-border bg-card p-4 shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md hover:border-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:hover:shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">
          Revenue vs Expenses
        </h3>
      </figcaption>

      <div
        className="aspect-video"
        role="img"
        aria-label="Line chart comparing monthly revenue and expenses"
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <LineChart
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
            <Tooltip content={<ComparisonTooltip />} />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
            />
            <Line
              type="monotone"
              dataKey="revenue"
              name="Revenue"
              stroke="var(--color-chart-revenue)"
              strokeWidth={2}
              dot={false}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              isAnimationActive={!reducedMotion}
            />
            <Line
              type="monotone"
              dataKey="expenses"
              name="Expenses"
              stroke="var(--color-chart-expense-1)"
              strokeWidth={2}
              strokeDasharray="6 3"
              dot={false}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              isAnimationActive={!reducedMotion}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
