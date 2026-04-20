import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AppError } from '../../lib/appError.js';
import type { ComputedStat, ScoredInsight, ScoringConfig } from './types.js';
import { StatType, scoringConfigSchema } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(): ScoringConfig {
  const configPath = resolve(__dirname, 'config', 'scoring-weights.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new AppError(
      'Scoring config missing: scoring-weights.json',
      'CONFIG_ERROR',
      500,
      err,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      'Scoring config is not valid JSON',
      'CONFIG_ERROR',
      500,
    );
  }

  const result = scoringConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(
      'Scoring config validation failed',
      'CONFIG_ERROR',
      500,
      result.error.issues,
    );
  }

  return result.data;
}

export const scoringConfig = loadConfig();

function noveltyScore(stat: ComputedStat): number {
  switch (stat.statType) {
    case StatType.Anomaly:
      return 0.9;
    case StatType.SeasonalProjection:
      return 0.85;
    case StatType.YearOverYear:
      return Math.abs(stat.details.changePercent) > 15 ? 0.85 : 0.6;
    case StatType.MarginTrend:
      return stat.details.direction !== 'stable' ? 0.8 : 0.35;
    case StatType.CashFlow:
      // 0.80 matches MarginTrend not-stable — pairs novelty tier exactly so the
      // total score lands at parity with MarginTrend shrinking, not above it.
      if (stat.details.direction === 'burning') {
        return stat.details.monthsBurning >= 2 ? 0.8 : 0.7;
      }
      return 0.5; // surplus
    case StatType.Runway:
      // Quantified risk > unquantified signal. 0.85 beats CashFlow burning (0.80)
      // because a month count is strictly more informative than direction alone.
      return stat.details.runwayMonths < 6 ? 0.85 : 0.65;
    case StatType.Trend:
      return Math.abs(stat.details.growthPercent) > scoringConfig.thresholds.significantChangePercent ? 0.8 : 0.4;
    case StatType.CategoryBreakdown:
      return 0.3;
    case StatType.Average:
      return 0.2;
    case StatType.Total:
      return 0.1;
  }
}

function actionabilityScore(stat: ComputedStat): number {
  switch (stat.statType) {
    case StatType.Anomaly:
      return Math.abs(stat.details.zScore) >= scoringConfig.thresholds.anomalyZScore ? 0.9 : 0.5;
    case StatType.SeasonalProjection:
      return stat.details.confidence === 'high' ? 0.9 : 0.7;
    case StatType.MarginTrend:
      return stat.details.direction === 'shrinking' ? 0.9 : 0.5;
    case StatType.CashFlow:
      // Ties MarginTrend shrinking at 0.9 — margin compression is the leading
      // signal, cash burn is the trailing consequence. Not inverted.
      if (stat.details.direction === 'burning') {
        return stat.details.monthsBurning >= 2 ? 0.9 : 0.75;
      }
      return 0.5; // surplus
    case StatType.Runway:
      // 0.95 is the highest actionability in the pipeline — runway <6 months
      // is existential. Drops sharply once there's room to breathe.
      if (stat.details.runwayMonths < 6) return 0.95;
      if (stat.details.runwayMonths < 24) return 0.70;
      return 0.45;
    case StatType.YearOverYear:
      return Math.abs(stat.details.changePercent) > 10 ? 0.8 : 0.4;
    case StatType.Trend:
      return Math.abs(stat.details.growthPercent) > scoringConfig.thresholds.significantChangePercent ? 0.85 : 0.3;
    case StatType.CategoryBreakdown:
      return 0.5;
    case StatType.Average:
      return 0.3;
    case StatType.Total:
      return 0.2;
  }
}

function specificityScore(stat: ComputedStat): number {
  switch (stat.statType) {
    case StatType.Anomaly:
      return stat.category !== null ? 0.95 : 0.7;
    case StatType.SeasonalProjection:
      return 0.85;
    case StatType.CashFlow:
      // 0.80 matches MarginTrend — paired deliberately to keep burning cash flow
      // at score parity (not above) shrinking margin. SeasonalProjection's 0.85
      // stays higher because it projects forward, a distinct kind of specificity.
      return 0.8;
    case StatType.Runway:
      // 0.90 flat — runway output is an exact month count. Nothing more specific
      // than "3.2 months" in this domain.
      return 0.9;
    case StatType.MarginTrend:
      return 0.8;
    case StatType.YearOverYear:
      return 0.75;
    default:
      return stat.category !== null ? 0.7 : 0.2;
  }
}

export function scoreInsights(stats: ComputedStat[]): ScoredInsight[] {
  if (stats.length === 0) return [];

  const scored: ScoredInsight[] = stats.map((stat) => {
    const nov = noveltyScore(stat);
    const act = actionabilityScore(stat);
    const spec = specificityScore(stat);

    const score =
      nov * scoringConfig.weights.novelty +
      act * scoringConfig.weights.actionability +
      spec * scoringConfig.weights.specificity;

    return {
      stat,
      score,
      breakdown: { novelty: nov, actionability: act, specificity: spec },
    };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, scoringConfig.topN);
}
