'use client';

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { ExpenseBreakdownItem } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface ExpenseChartProps {
  data: ExpenseBreakdownItem[];
}

export function ExpenseTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ value: number | null }>;
  label?: string;
}) {
  if (!active || !payload?.[0]) return null;

  const value = payload[0].value;
  const display = value == null ? 'No data for this category' : formatCurrency(value);

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

const CATEGORY_COLORS = [
  'var(--color-chart-expense-1)',
  'var(--color-chart-expense-2)',
  'var(--color-chart-expense-3)',
  'var(--color-chart-expense-4)',
  'var(--color-chart-expense-5)',
  'var(--color-chart-expense-6)',
];

export function ExpenseChart({ data }: ExpenseChartProps) {
  const reducedMotion = useReducedMotion();
  const totalExpenses = data.reduce((sum, item) => sum + item.total, 0);
  const topCategory = data[0];

  return (
    <figure className="card-hover rounded-lg border border-border bg-card p-4 shadow-sm md:p-6">
      <figcaption className="mb-4">
        <h3 className="text-base font-semibold text-card-foreground">
          Expense Breakdown
        </h3>
      </figcaption>

      <div
        className="aspect-video"
        role="img"
        aria-label={`Bar chart showing expense breakdown by category${topCategory ? `, highest is ${topCategory.category} at ${formatCurrency(topCategory.total)}` : ''}`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <BarChart
            data={data}
            title="Expense breakdown by category"
            margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="category"
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
            <Tooltip content={<ExpenseTooltip />} />
            <Bar
              dataKey="total"
              radius={[4, 4, 0, 0]}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              animationEasing={CHART_CONFIG.ANIMATION_EASING}
              isAnimationActive={!reducedMotion}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 text-sm text-muted-foreground" style={{ fontFeatureSettings: '"tnum"', lineHeight: '1.5' }}>
        {totalExpenses === 0 ? (
          <span className="text-muted-foreground">$0 total</span>
        ) : (
          <span>{formatCurrency(totalExpenses)} total across {data.length} categories</span>
        )}
      </div>
    </figure>
  );
}
