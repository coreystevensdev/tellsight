import { LineChart, Line, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts';
import { EMAIL_CHART_COLORS } from 'shared/constants';
import { formatAbbreviated } from 'shared/formatting';

export interface CashFlowChartPoint {
  month: string;
  revenue: number;
  expenses: number;
}

export interface CashFlowEmailChartProps {
  width: number;
  height: number;
  points: CashFlowChartPoint[];
}

// Recharts draws <Legend> as an HTML list outside the <svg>, so the email
// pipeline, which rasterises the surface alone, never captured it. Labelling
// each line at its own end keeps the naming inside the SVG and drops the
// eye-travel a legend costs.
function endLabel(text: string, fill: string, lastIndex: number) {
  // Recharts types the point geometry as string | number.
  return function EndLabel({
    x,
    y,
    index,
  }: {
    x?: string | number;
    y?: string | number;
    index?: number;
  }) {
    if (index !== lastIndex) return null;
    return (
      <text x={Number(x ?? 0) + 14} y={Number(y ?? 0) + 8} fill={fill} fontSize={22}>
        {text}
      </text>
    );
  };
}

// Mirrors RevenueVsExpensesChart's two-line shape; cash_burn_spikes fires off
// CashFlowDetails.recentMonths, which already has this exact point shape.
export function CashFlowEmailChart({ width, height, points }: CashFlowEmailChartProps) {
  return (
    <LineChart width={width} height={height} data={points} margin={{ top: 16, right: 170, bottom: 16, left: 16 }}>
      <CartesianGrid strokeDasharray="6 6" stroke={EMAIL_CHART_COLORS.grid} />
      <XAxis dataKey="month" tick={{ fontSize: 22 }} tickLine={false} axisLine={false} />
      <YAxis tickFormatter={formatAbbreviated} tick={{ fontSize: 22 }} tickLine={false} axisLine={false} width={100} />
      <Line
        type="monotone"
        dataKey="revenue"
        name="Revenue"
        stroke={EMAIL_CHART_COLORS.revenue}
        strokeWidth={4}
        dot={false}
        isAnimationActive={false}
      >
        <LabelList
          content={endLabel('Revenue', EMAIL_CHART_COLORS.revenue, points.length - 1)}
        />
      </Line>
      <Line
        type="monotone"
        dataKey="expenses"
        name="Expenses"
        stroke={EMAIL_CHART_COLORS.expense}
        strokeWidth={4}
        strokeDasharray="12 6"
        dot={false}
        isAnimationActive={false}
      >
        <LabelList
          content={endLabel('Expenses', EMAIL_CHART_COLORS.expense, points.length - 1)}
        />
      </Line>
    </LineChart>
  );
}
