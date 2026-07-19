import type { StatDetailView } from 'shared/types';

import type { IdentifiedStat } from './types.js';
import { StatType } from './types.js';
import { usd, usdSigned, usdMinus } from './assembly.js';

// Reconciles an already-computed stat into the number(s) the audit drawer
// shows the owner. Every field here comes straight off `stat.details` or
// `stat.value`, nothing is recomputed, so the displayed formula/method
// always matches what the summary cited (NFR-12.3).
export function buildStatDetail(stat: IdentifiedStat): StatDetailView {
  switch (stat.statType) {
    case StatType.Total: {
      const total = `$${usd.format(stat.value)}`;
      return {
        kind: 'formula',
        expression: `${stat.details.count} transactions summing to ${total}`,
        terms: [
          { label: 'Transaction count', value: String(stat.details.count) },
          { label: 'Total', value: total },
        ],
      };
    }

    case StatType.Average: {
      const avg = `$${stat.value.toFixed(2)}`;
      const med = `$${stat.details.median.toFixed(2)}`;
      return {
        kind: 'formula',
        expression: `average ${avg}, median ${med}`,
        terms: [
          { label: 'Average', value: avg },
          { label: 'Median', value: med },
        ],
      };
    }

    case StatType.CashFlow: {
      const nets = stat.details.recentMonths.map((m) => usdSigned(m.net)).join(', ');
      const net = usdSigned(stat.details.monthlyNet);
      return {
        kind: 'formula',
        expression: `median(${nets}) = ${net}/mo`,
        terms: stat.details.recentMonths.map((m) => ({ label: m.month, value: usdSigned(m.net) })),
      };
    }

    case StatType.Runway: {
      const cash = `$${usd.format(stat.details.cashOnHand)}`;
      const net = usdSigned(stat.details.monthlyNet);
      const months = `${stat.details.runwayMonths.toFixed(1)} months`;
      return {
        kind: 'formula',
        expression: `${cash} ÷ ${net}/mo = ${months}`,
        terms: [
          { label: 'Cash on hand', value: cash },
          { label: 'Monthly net', value: net },
          { label: 'Runway', value: months },
        ],
      };
    }

    case StatType.BreakEven: {
      const fixed = `$${usd.format(stat.details.monthlyFixedCosts)}`;
      const margin = `${stat.details.marginPercent.toFixed(1)}%`;
      const breakEven = `$${usd.format(stat.details.breakEvenRevenue)}`;
      return {
        kind: 'formula',
        expression: `${fixed} / (${margin} / 100) = ${breakEven}`,
        terms: [
          { label: 'Current revenue', value: `$${usd.format(stat.details.currentMonthlyRevenue)}` },
          { label: 'Gap to break-even', value: usdMinus(stat.details.gap) },
        ],
      };
    }

    case StatType.YearOverYear: {
      const current = `$${usd.format(stat.details.currentYear)}`;
      const prior = `$${usd.format(stat.details.priorYear)}`;
      const change = `${stat.details.changePercent >= 0 ? '+' : ''}${stat.details.changePercent.toFixed(1)}%`;
      return {
        kind: 'formula',
        expression: `(${current} - ${prior}) / ${prior} = ${change}`,
        terms: [
          { label: stat.details.currentYearLabel, value: current },
          { label: stat.details.priorYearLabel, value: prior },
        ],
      };
    }

    case StatType.MarginTrend: {
      const recent = `${stat.details.recentMarginPercent.toFixed(1)}%`;
      const prior = `${stat.details.priorMarginPercent.toFixed(1)}%`;
      return {
        kind: 'formula',
        expression: `${recent} recent margin vs ${prior} prior margin (${stat.details.direction})`,
        terms: [
          {
            label: 'Revenue growth',
            value: `${stat.details.revenueGrowthPercent >= 0 ? '+' : ''}${stat.details.revenueGrowthPercent.toFixed(1)}%`,
          },
          {
            label: 'Expense growth',
            value: `${stat.details.expenseGrowthPercent >= 0 ? '+' : ''}${stat.details.expenseGrowthPercent.toFixed(1)}%`,
          },
        ],
      };
    }

    case StatType.CategoryBreakdown: {
      const abs = `$${usd.format(stat.details.absoluteTotal)}`;
      const pct = `${stat.details.percentage.toFixed(1)}%`;
      return {
        kind: 'formula',
        expression: `${abs} / total = ${pct}`,
        terms: [
          { label: 'Transactions', value: String(stat.details.transactionCount) },
          { label: 'Range', value: `$${stat.details.min.toFixed(0)}-$${stat.details.max.toFixed(0)}` },
        ],
      };
    }

    case StatType.Trend: {
      return {
        kind: 'inputs',
        methodName: 'Linear regression over the trailing data points',
        inputs: [
          { label: 'Data points', value: String(stat.details.dataPoints) },
          { label: 'First value', value: `$${stat.details.firstValue.toFixed(0)}` },
          { label: 'Last value', value: `$${stat.details.lastValue.toFixed(0)}` },
          {
            label: 'Growth',
            value: `${stat.details.growthPercent >= 0 ? '+' : ''}${stat.details.growthPercent.toFixed(1)}%`,
          },
        ],
      };
    }

    case StatType.Anomaly: {
      return {
        kind: 'inputs',
        methodName: 'Z-score vs category baseline (IQR outlier detection)',
        inputs: [
          { label: 'Value', value: `$${stat.value.toFixed(2)}` },
          { label: 'Z-score', value: stat.details.zScore.toFixed(2) },
          {
            label: 'Expected range',
            value: `$${stat.details.iqrBounds.lower.toFixed(0)}-$${stat.details.iqrBounds.upper.toFixed(0)}`,
          },
          { label: 'Deviation', value: usdMinus(stat.details.deviation) },
        ],
      };
    }

    case StatType.SeasonalProjection: {
      return {
        kind: 'inputs',
        methodName: 'Seasonal projection from prior-year same-month basis',
        inputs: [
          { label: 'Projected month', value: stat.details.projectedMonth },
          { label: 'Projected amount', value: `$${usd.format(stat.details.projectedAmount)}` },
          { label: 'Basis months', value: stat.details.basisMonths.join(', ') },
          { label: 'Confidence', value: stat.details.confidence },
        ],
      };
    }

    case StatType.CashForecast: {
      const methodName = stat.details.method === 'linear_regression'
        ? 'Linear regression on trailing monthly net'
        : 'Rolling mean of trailing monthly net';
      const finalMonth = stat.details.projectedMonths[stat.details.projectedMonths.length - 1];
      return {
        kind: 'inputs',
        methodName,
        inputs: [
          { label: 'Starting balance', value: usdMinus(stat.details.startingBalance) },
          {
            label: 'Projected balance (3mo)',
            value: finalMonth ? usdMinus(finalMonth.projectedBalance) : usdMinus(stat.value),
          },
          { label: 'Basis months', value: String(stat.details.basisMonths.length) },
          {
            label: 'Crosses zero at month',
            value: stat.details.crossesZeroAtMonth != null ? String(stat.details.crossesZeroAtMonth) : 'not projected',
          },
          { label: 'Confidence', value: stat.details.confidence },
        ],
      };
    }
  }
}
