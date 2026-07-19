import { LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
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

// Mirrors RevenueVsExpensesChart's two-line shape; cash_burn_spikes fires off
// CashFlowDetails.recentMonths, which already has this exact point shape.
export function CashFlowEmailChart({ width, height, points }: CashFlowEmailChartProps) {
  return (
    <LineChart width={width} height={height} data={points} margin={{ top: 16, right: 40, bottom: 16, left: 16 }}>
      <CartesianGrid strokeDasharray="6 6" stroke={EMAIL_CHART_COLORS.grid} />
      <XAxis dataKey="month" tick={{ fontSize: 22 }} tickLine={false} axisLine={false} />
      <YAxis tickFormatter={formatAbbreviated} tick={{ fontSize: 22 }} tickLine={false} axisLine={false} width={100} />
      <Legend iconType="circle" iconSize={14} wrapperStyle={{ fontSize: 22, paddingTop: 12 }} />
      <Line
        type="monotone"
        dataKey="revenue"
        name="Revenue"
        stroke={EMAIL_CHART_COLORS.revenue}
        strokeWidth={4}
        dot={false}
        isAnimationActive={false}
      />
      <Line
        type="monotone"
        dataKey="expenses"
        name="Expenses"
        stroke={EMAIL_CHART_COLORS.expense}
        strokeWidth={4}
        strokeDasharray="12 6"
        dot={false}
        isAnimationActive={false}
      />
    </LineChart>
  );
}
