import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { EMAIL_CHART_COLORS } from 'shared/constants';
import { formatAbbreviated } from 'shared/formatting';

export interface RunwayChartPoint {
  label: string;
  balance: number;
}

export interface RunwayEmailChartProps {
  width: number;
  height: number;
  points: RunwayChartPoint[];
}

// The alert payload only carries a runway snapshot (cashOnHand, monthlyNet,
// runwayMonths), not the historical balance series the dashboard's
// RunwayTrendChart draws from. So this chart is the projection segment only,
// dashed throughout, no solid "historical" half.
export function RunwayEmailChart({ width, height, points }: RunwayEmailChartProps) {
  return (
    <LineChart width={width} height={height} data={points} margin={{ top: 16, right: 40, bottom: 16, left: 16 }}>
      <CartesianGrid strokeDasharray="6 6" stroke={EMAIL_CHART_COLORS.grid} />
      <XAxis dataKey="label" tick={{ fontSize: 22 }} tickLine={false} axisLine={false} />
      <YAxis tickFormatter={formatAbbreviated} tick={{ fontSize: 22 }} tickLine={false} axisLine={false} width={100} />
      <Line
        type="monotone"
        dataKey="balance"
        stroke={EMAIL_CHART_COLORS.revenue}
        strokeWidth={4}
        strokeDasharray="10 8"
        dot={{ r: 6, fill: EMAIL_CHART_COLORS.revenueDot }}
        isAnimationActive={false}
      />
    </LineChart>
  );
}
