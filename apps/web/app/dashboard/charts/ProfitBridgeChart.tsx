'use client';

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { ExpenseBreakdownItem, MonthlyComparisonPoint } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface ProfitBridgeChartProps {
  monthlyComparison: MonthlyComparisonPoint[];
  expenseBreakdown: ExpenseBreakdownItem[];
}

export interface BridgeStep {
  label: string;
  base: number;
  value: number;
  delta: number;
}

interface BridgeResult {
  steps: BridgeStep[];
  totalRevenue: number;
  bridgeProfit: number;
  reportedProfit: number;
  closes: boolean;
  domain: [number, number];
}

// expenseBreakdown has no per-month split, only a total for the filtered
// range, so the bridge has to cover that same range rather than one month.
// Summing monthlyComparison across all of it keeps both ends and every step
// describing one window instead of two.
const MAX_NAMED_CATEGORIES = 6;

// A real category can already be named Other, a common catch-all in a chart
// of accounts. Merging the overflow into it instead of adding a second entry
// keeps the bridge from showing two bars sharing one label with different
// values.
function foldOverflowIntoOther(sorted: ExpenseBreakdownItem[]): ExpenseBreakdownItem[] {
  const named = sorted.slice(0, MAX_NAMED_CATEGORIES);
  const overflowTotal = sorted.slice(MAX_NAMED_CATEGORIES).reduce((sum, e) => sum + e.total, 0);

  const otherIndex = named.findIndex((c) => c.category.toLowerCase() === 'other');
  if (otherIndex >= 0) {
    return named.map((c, i) => (i === otherIndex ? { ...c, total: c.total + overflowTotal } : c));
  }
  return [...named, { category: 'Other', total: overflowTotal }];
}

export function buildBridge(
  monthlyComparison: MonthlyComparisonPoint[],
  expenseBreakdown: ExpenseBreakdownItem[],
): BridgeResult {
  const totalRevenue = monthlyComparison.reduce((sum, p) => sum + p.revenue, 0);
  const reportedProfit = monthlyComparison.reduce((sum, p) => sum + p.profit, 0);

  // expenseBreakdown arrives sorted descending from charts.ts, but sorting
  // again here is one line and means Other always folds in the smallest
  // categories even if a caller (or a future server change) hands this
  // function unsorted data. Tied totals break on category name: charts.ts
  // orders its aggregation by bucket alone with no secondary key on
  // category (charts.ts:109), and its own sort has the same gap
  // (charts.ts:173), so a tie at the boundary would otherwise flip which
  // category is named depending on what order Postgres happens to return.
  const sorted = [...expenseBreakdown].sort(
    (a, b) => b.total - a.total || a.category.localeCompare(b.category),
  );
  const categories = sorted.length > MAX_NAMED_CATEGORIES
    ? foldOverflowIntoOther(sorted)
    : sorted;

  const steps: BridgeStep[] = [
    { label: 'Revenue', base: Math.min(0, totalRevenue), value: Math.abs(totalRevenue), delta: totalRevenue },
  ];

  let running = totalRevenue;
  for (const { category, total } of categories) {
    const delta = -total;
    const next = running + delta;
    steps.push({ label: category, base: Math.min(running, next), value: Math.abs(next - running), delta });
    running = next;
  }

  const bridgeProfit = running;
  // Profit reads from zero, the same as Revenue, instead of floating off the
  // last step, so its bar height is directly comparable to Revenue's.
  steps.push({ label: 'Profit', base: Math.min(0, bridgeProfit), value: Math.abs(bridgeProfit), delta: bridgeProfit });

  // The self-check this chart exists for: expenseBreakdown and
  // monthlyComparison are computed independently in charts.ts, so if the
  // bucketing ever drifts between them the cumulative steps stop landing on
  // the profit the rest of the dashboard already reports. Compared at the
  // cent, which is the precision round2 already commits both sides to.
  const closes = Math.round(bridgeProfit * 100) === Math.round(reportedProfit * 100);

  const rawMin = Math.min(0, ...steps.map((s) => s.base));
  const rawMax = Math.max(0, ...steps.map((s) => s.base + s.value));
  const pad = (rawMax - rawMin) * 0.08 || 1;

  return {
    steps,
    totalRevenue,
    bridgeProfit,
    reportedProfit,
    closes,
    domain: [rawMin < 0 ? rawMin - pad : rawMin, rawMax + pad],
  };
}

export function colorForDelta(delta: number): string {
  return delta >= 0 ? 'var(--color-success)' : 'var(--color-destructive)';
}

export function BridgeTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; payload?: BridgeStep }>;
}) {
  if (!active || !payload?.length) return null;

  // Both the invisible base and the visible value segment report into the
  // same hover payload; only the value one carries a step worth showing.
  const step = payload.find((p) => p.dataKey === 'value')?.payload;
  if (!step) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{step.label}</p>
      <p
        className={step.delta >= 0 ? 'font-semibold text-success' : 'font-semibold text-destructive'}
        style={{ fontFeatureSettings: '"tnum"' }}
      >
        {step.delta >= 0 ? '+' : ''}{formatCurrency(step.delta)}
      </p>
    </div>
  );
}

export function ProfitBridgeChart({ monthlyComparison, expenseBreakdown }: ProfitBridgeChartProps) {
  const reducedMotion = useReducedMotion();

  if (monthlyComparison.length === 0) return null;

  const { steps, totalRevenue, bridgeProfit, closes, domain } = buildBridge(monthlyComparison, expenseBreakdown);

  if (!closes) {
    return (
      <figure className="border-t-2 border-border bg-card p-4 transition-colors duration-200 ease-out hover:border-primary md:p-6">
        <figcaption className="mb-4">
          <h3 className="font-serif text-lg font-medium text-card-foreground">
            Revenue to Profit
          </h3>
        </figcaption>
        <p role="status" className="text-sm text-muted-foreground">
          Revenue, expenses and profit do not add up for this range, so no bridge is shown.
        </p>
      </figure>
    );
  }

  const categoryCount = expenseBreakdown.length;

  return (
    <figure className="border-t-2 border-border bg-card p-4 transition-colors duration-200 ease-out hover:border-primary md:p-6">
      <figcaption className="mb-4">
        <h3 className="font-serif text-lg font-medium text-card-foreground">
          Revenue to Profit
        </h3>
      </figcaption>

      <div
        className="aspect-[2.5/1]"
        role="img"
        aria-label={`Waterfall chart showing revenue of ${formatCurrency(totalRevenue)} stepping down through expenses to profit of ${formatCurrency(bridgeProfit)}`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <BarChart
            data={steps}
            title="Revenue to profit bridge"
            margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
            accessibilityLayer
          >
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.01em' }}
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
              domain={domain}
            />
            <Tooltip content={<BridgeTooltip />} />
            <ReferenceLine y={0} stroke="var(--color-border)" strokeDasharray="3 3" />
            <Bar
              dataKey="base"
              stackId="bridge"
              fill="transparent"
              activeBar={false}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
            <Bar
              dataKey="value"
              stackId="bridge"
              radius={[4, 4, 0, 0]}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              animationEasing={CHART_CONFIG.ANIMATION_EASING}
              isAnimationActive={!reducedMotion}
            >
              {steps.map((step, i) => (
                <Cell key={i} fill={colorForDelta(step.delta)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 text-sm text-muted-foreground" style={{ fontFeatureSettings: '"tnum"', lineHeight: '1.5' }}>
        <span className={bridgeProfit >= 0 ? 'font-semibold text-success' : 'font-semibold text-destructive'}>
          {formatCurrency(bridgeProfit)}
        </span>{' '}
        profit from {formatCurrency(totalRevenue)} revenue
        {categoryCount > 0 ? ` across ${categoryCount} expense ${categoryCount === 1 ? 'category' : 'categories'}` : ''}
      </div>
    </figure>
  );
}
