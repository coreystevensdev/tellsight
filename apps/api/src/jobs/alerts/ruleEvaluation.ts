import type { AlertRuleRow } from '../../db/queries/alertRules.js';
import { logger } from '../../lib/logger.js';
import { StatType } from '../../services/curation/index.js';
import type { ScoredInsight } from '../../services/curation/index.js';
import * as anomalyBands from './bands/anomalyBands.js';
import * as breakevenBands from './bands/breakevenBands.js';
import * as cashBurnBands from './bands/cashBurnBands.js';
import * as marginBands from './bands/marginBands.js';
import * as runwayBands from './bands/runwayBands.js';

export interface RuleEvaluation {
  currentValue: number;
  band: number | null;
  insight: ScoredInsight;
}

function evaluateRunway(
  insights: ScoredInsight[],
  threshold: number,
): RuleEvaluation | null {
  const insight = insights.find((candidate) => candidate.stat.statType === StatType.Runway);
  if (!insight || insight.stat.statType !== StatType.Runway) return null;
  const currentValue = insight.stat.details.runwayMonths;
  return { currentValue, band: runwayBands.getBand(currentValue, threshold), insight };
}

function evaluateMargin(
  insights: ScoredInsight[],
  threshold: number,
): RuleEvaluation | null {
  const insight = insights.find(
    (candidate) => candidate.stat.statType === StatType.MarginTrend,
  );
  if (!insight || insight.stat.statType !== StatType.MarginTrend) return null;
  const currentValue =
    insight.stat.details.priorMarginPercent - insight.stat.details.recentMarginPercent;
  return { currentValue, band: marginBands.getBand(currentValue, threshold), insight };
}

function evaluateCashBurn(
  cashFlowInsight: ScoredInsight | null,
  threshold: number,
): RuleEvaluation | null {
  if (!cashFlowInsight || cashFlowInsight.stat.statType !== StatType.CashFlow) return null;

  const months = cashFlowInsight.stat.details.recentMonths;
  if (months.length < 2) return { currentValue: 0, band: null, insight: cashFlowInsight };

  const latest = months[months.length - 1]!;
  const priorMonths = months.slice(0, -1);
  const priorAverageExpenses =
    priorMonths.reduce((sum, month) => sum + month.expenses, 0) / priorMonths.length;
  const currentValue =
    priorAverageExpenses > 0
      ? ((latest.expenses - priorAverageExpenses) / priorAverageExpenses) * 100
      : latest.expenses > 0
        ? threshold * 3
        : 0;

  return {
    currentValue,
    band: cashBurnBands.getBand(currentValue, threshold),
    insight: cashFlowInsight,
  };
}

function evaluateBreakeven(
  insights: ScoredInsight[],
  threshold: number,
): RuleEvaluation | null {
  const insight = insights.find(
    (candidate) => candidate.stat.statType === StatType.BreakEven,
  );
  if (!insight || insight.stat.statType !== StatType.BreakEven) return null;

  const { gap, breakEvenRevenue } = insight.stat.details;
  const currentValue =
    breakEvenRevenue > 0 ? (gap / breakEvenRevenue) * 100 : gap > 0 ? threshold * 3 : 0;
  return { currentValue, band: breakevenBands.getBand(currentValue, threshold), insight };
}

function evaluateAnomaly(
  insights: ScoredInsight[],
  threshold: 'low' | 'moderate' | 'high',
): RuleEvaluation | null {
  const anomalyInsights = insights.filter(
    (candidate) => candidate.stat.statType === StatType.Anomaly,
  );
  if (anomalyInsights.length === 0) return null;

  const mostSevere = anomalyInsights.reduce((maximum, candidate) => {
    if (
      candidate.stat.statType !== StatType.Anomaly ||
      maximum.stat.statType !== StatType.Anomaly
    ) {
      return maximum;
    }
    return Math.abs(candidate.stat.details.zScore) > Math.abs(maximum.stat.details.zScore)
      ? candidate
      : maximum;
  });
  if (mostSevere.stat.statType !== StatType.Anomaly) return null;

  const currentValue = anomalyBands.confidenceOrdinalFromZScore(
    mostSevere.stat.details.zScore,
  );
  return {
    currentValue,
    band: anomalyBands.getBand(currentValue, threshold),
    insight: mostSevere,
  };
}

export function evaluateRule(
  insights: ScoredInsight[],
  cashFlowInsight: ScoredInsight | null,
  rule: AlertRuleRow,
): RuleEvaluation | null {
  switch (rule.kind) {
    case 'runway_runs_short':
      return evaluateRunway(insights, (rule.threshold as { months: number }).months);
    case 'margin_drops':
      return evaluateMargin(insights, (rule.threshold as { percent: number }).percent);
    case 'cash_burn_spikes':
      return evaluateCashBurn(cashFlowInsight, (rule.threshold as { percent: number }).percent);
    case 'breakeven_gap_widens':
      return evaluateBreakeven(insights, (rule.threshold as { percent: number }).percent);
    case 'anomaly_fires':
      return evaluateAnomaly(
        insights,
        (rule.threshold as { confidence: 'low' | 'moderate' | 'high' }).confidence,
      );
    default: {
      const exhaustive: never = rule.kind;
      logger.error(
        { ruleId: rule.id, ruleKind: exhaustive },
        'Unknown alert rule kind, no evaluator wired',
      );
      return null;
    }
  }
}
