'use client';

import {
  ComposedChart,
  Bar,
  Cell,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { CategoryVarianceItem } from 'shared/types';
import { CHART_CONFIG } from 'shared/constants';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { formatCurrency, formatAbbreviated } from './formatters';

interface CategoryVarianceChartProps {
  data: CategoryVarianceItem[];
}

// Measured against real recharts: a 343px card renders a 44.7px band at six
// categories, the cap below. 28px leaves real margin at that floor instead
// of the 44px this was before the cap existed, which was already flush with
// the band at six and overlapping past it, since nothing bounded how many
// plans could reach this chart (/settings/plans allows up to 100).
const MARKER_WIDTH = 28;
const MARKER_HEIGHT = 3;
const MAX_NAMED_CATEGORIES = 6;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function mergeIntoOther(base: CategoryVarianceItem, extra: CategoryVarianceItem[]): CategoryVarianceItem {
  const plannedMonthly = round2(base.plannedMonthly + extra.reduce((s, c) => s + c.plannedMonthly, 0));
  const actualMonthly = round2(base.actualMonthly + extra.reduce((s, c) => s + c.actualMonthly, 0));
  const variance = round2(actualMonthly - plannedMonthly);
  const variancePercent = plannedMonthly === 0 ? 0 : Math.round((variance / plannedMonthly) * 1000) / 10;
  const direction: CategoryVarianceItem['direction'] =
    Math.abs(variancePercent) < 5 ? 'on_plan' : variance > 0 ? 'over' : 'under';

  return { ...base, plannedMonthly, actualMonthly, variance, variancePercent, direction };
}

// Same problem ProfitBridgeChart solves and the same fix: a fixed bar width
// and marker width against an uncapped, data-dependent number of bars is how
// bars end up wider than their own band. categoryPlansInputSchema permits up
// to 100 plans and /settings/plans lets an owner plan every category they
// have, so six-plus is reachable, not hypothetical. A real plan can already
// be named Other, so folding into it instead of adding a second entry keeps
// two rows from sharing one label with different numbers.
export function foldOverflowIntoOther(data: CategoryVarianceItem[]): CategoryVarianceItem[] {
  const named = data.slice(0, MAX_NAMED_CATEGORIES);
  const overflow = data.slice(MAX_NAMED_CATEGORIES);
  if (overflow.length === 0) return named;

  const otherIndex = named.findIndex((c) => c.category.toLowerCase() === 'other');
  if (otherIndex >= 0) {
    return named.map((c, i) => (i === otherIndex ? mergeIntoOther(c, overflow) : c));
  }

  const seed: CategoryVarianceItem = {
    category: 'Other',
    plannedMonthly: 0,
    actualMonthly: 0,
    variance: 0,
    variancePercent: 0,
    monthLabel: data[0]!.monthLabel,
    direction: 'on_plan',
  };
  return [...named, mergeIntoOther(seed, overflow)];
}

// direction, not the sign of variance: for spend, over plan is bad, the
// opposite of the bridge chart's profit deltas, so this can't reuse
// colorForDelta without painting an overspend green.
export function colorForDirection(direction: CategoryVarianceItem['direction']): string {
  if (direction === 'over') return 'var(--color-destructive)';
  if (direction === 'under') return 'var(--color-success)';
  return 'var(--color-muted-foreground)';
}

// Rendered via Scatter rather than a second stacked Bar: its pixel position
// comes from plannedMonthly through the shared y-scale, so it lands correctly
// even when actualMonthly is zero, the one case a bar-height-ratio trick
// can't handle. A grouped second bar was ruled out in the design doc: two
// bars makes the reader compare heights, one bar crossing a line does not.
// Passed to Scatter as `shape={PlannedMarker}` rather than wrapped in an
// arrow: recharts calls a function shape as `shape(props, index)`, not as a
// component, so the bare reference works the same and does not hand Scatter
// a new closure identity on every render.
export function PlannedMarker({ cx, cy }: { cx?: number; cy?: number }) {
  if (cx == null || cy == null) return null;
  return (
    <rect
      x={cx - MARKER_WIDTH / 2}
      y={cy - MARKER_HEIGHT / 2}
      width={MARKER_WIDTH}
      height={MARKER_HEIGHT}
      fill="var(--color-foreground)"
    />
  );
}

export function VarianceTooltip({ active, payload }: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; payload?: CategoryVarianceItem }>;
}) {
  if (!active || !payload?.length) return null;

  // Bar and Scatter both report into the same hover payload; the bar entry
  // carries the full row, the marker's carries the same payload too, so
  // either works, but asking for the bar's by name keeps this independent of
  // series order.
  const item = payload.find((p) => p.dataKey === 'actualMonthly')?.payload;
  if (!item) return null;

  const directionClass =
    item.direction === 'over' ? 'text-destructive' : item.direction === 'under' ? 'text-success' : 'text-muted-foreground';

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card px-3 py-2 text-sm shadow-md"
    >
      <p className="font-medium text-card-foreground">{item.category}</p>
      <p className="text-muted-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
        {formatCurrency(item.actualMonthly)} of {formatCurrency(item.plannedMonthly)} planned
      </p>
      <p className={`font-semibold ${directionClass}`} style={{ fontFeatureSettings: '"tnum"' }}>
        {item.variance >= 0 ? '+' : ''}{formatCurrency(item.variance)} vs plan
      </p>
    </div>
  );
}

export function CategoryVarianceChart({ data }: CategoryVarianceChartProps) {
  const reducedMotion = useReducedMotion();

  if (data.length === 0) return null;

  // The fold is a rendering concession, not a change to the real numbers: the
  // bars below read chartData, but the summary line keeps summing data, so
  // an org with eight plans still reports "across 8 categories" rather than
  // the seven bars actually drawn.
  const chartData = foldOverflowIntoOther(data);
  const monthLabel = data[0]!.monthLabel;
  const totalPlanned = data.reduce((sum, d) => sum + d.plannedMonthly, 0);
  const totalActual = data.reduce((sum, d) => sum + d.actualMonthly, 0);

  return (
    <figure className="border-t-2 border-border bg-card p-4 transition-colors duration-200 ease-out hover:border-primary md:p-6">
      <figcaption className="mb-4">
        <h3 className="font-serif text-lg font-medium text-card-foreground">
          Budget vs Actual
        </h3>
      </figcaption>

      <div
        className="aspect-[2.5/1]"
        role="img"
        aria-label={`Bar chart comparing actual spend to planned budget by category for ${monthLabel}`}
      >
        <ResponsiveContainer width="100%" height="100%" debounce={CHART_CONFIG.RESIZE_DEBOUNCE_MS}>
          <ComposedChart
            data={chartData}
            title="Budget vs actual by category"
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
              tick={{ fontSize: 12, fontWeight: 500 }}
              className="fill-muted-foreground"
              tickLine={false}
              axisLine={false}
              width={55}
            />
            <Tooltip content={<VarianceTooltip />} />
            <Bar
              dataKey="actualMonthly"
              radius={[4, 4, 0, 0]}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
              animationEasing={CHART_CONFIG.ANIMATION_EASING}
              isAnimationActive={!reducedMotion}
            >
              {chartData.map((item, i) => (
                <Cell key={i} fill={colorForDirection(item.direction)} />
              ))}
            </Bar>
            <Scatter
              dataKey="plannedMonthly"
              fill="transparent"
              shape={PlannedMarker}
              isAnimationActive={!reducedMotion}
              animationDuration={CHART_CONFIG.ANIMATION_DURATION_MS}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 text-sm text-muted-foreground" style={{ fontFeatureSettings: '"tnum"', lineHeight: '1.5' }}>
        {formatCurrency(totalActual)} spent of {formatCurrency(totalPlanned)} planned across{' '}
        {data.length} {data.length === 1 ? 'category' : 'categories'}, {monthLabel}
      </div>
    </figure>
  );
}
