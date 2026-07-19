import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { EMAIL_CHART_COLORS } from 'shared/constants';
import { formatPercent } from 'shared/formatting';

export interface MarginChartPoint {
  label: string;
  marginPercent: number;
}

export interface MarginEmailChartProps {
  width: number;
  height: number;
  points: MarginChartPoint[];
  direction: 'expanding' | 'shrinking' | 'stable';
}

// MarginTrendDetails has no monthly series, just a prior/recent pair, so this
// is a two-point area (mirrors ProfitMarginChart's area styling, not its
// month-by-month shape). Fill color follows direction; margin_drops only
// fires on 'shrinking' in practice, but the other directions stay handled.
export function MarginEmailChart({ width, height, points, direction }: MarginEmailChartProps) {
  const color = direction === 'shrinking' ? EMAIL_CHART_COLORS.destructive : EMAIL_CHART_COLORS.success;

  return (
    <AreaChart width={width} height={height} data={points} margin={{ top: 16, right: 40, bottom: 16, left: 16 }}>
      <CartesianGrid strokeDasharray="6 6" stroke={EMAIL_CHART_COLORS.grid} />
      <XAxis dataKey="label" tick={{ fontSize: 22 }} tickLine={false} axisLine={false} />
      <YAxis tickFormatter={formatPercent} tick={{ fontSize: 22 }} tickLine={false} axisLine={false} width={90} />
      <Area
        type="monotone"
        dataKey="marginPercent"
        stroke={color}
        fill={color}
        fillOpacity={0.15}
        strokeWidth={4}
        isAnimationActive={false}
      />
    </AreaChart>
  );
}
