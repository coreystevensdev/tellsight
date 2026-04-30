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
      if (stat.details.direction === 'burning') {
        return stat.details.monthsBurning >= 2 ? 0.8 : 0.7;
      }
      return 0.5; // surplus
    case StatType.Runway:
      // Month count beats CashFlow's direction-only signal.
      return stat.details.runwayMonths < 6 ? 0.85 : 0.65;
    case StatType.BreakEven:
      // Below break-even gives a concrete revenue target; above it is reassuring.
      return stat.details.gap > 0 ? 0.75 : 0.60;
    case StatType.CashForecast:
      // crossesZeroAtMonth !== null means the projection pierces zero in 3 months.
      return stat.details.crossesZeroAtMonth !== null ? 0.85 : 0.65;
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
      if (stat.details.direction === 'burning') {
        return stat.details.monthsBurning >= 2 ? 0.9 : 0.75;
      }
      return 0.5; // surplus
    case StatType.Runway:
      // <6 months is existential, highest in the pipeline.
      if (stat.details.runwayMonths < 6) return 0.95;
      if (stat.details.runwayMonths < 24) return 0.70;
      return 0.45;
    case StatType.BreakEven:
      return stat.details.gap > 0 ? 0.88 : 0.55;
    case StatType.CashForecast:
      return stat.details.crossesZeroAtMonth !== null ? 0.92 : 0.55;
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

// Scoring-order invariant for critical signals:
//   Runway (0.9025) > CashForecast crosses-zero (0.8775) > CashFlow burning (0.8400) > BreakEven gap-positive (0.8270).
// If a tweak flips this order, all rationales need review.
function specificityScore(stat: ComputedStat): number {
  switch (stat.statType) {
    case StatType.Anomaly:
      return stat.category !== null ? 0.95 : 0.7;
    case StatType.SeasonalProjection:
      return 0.85;
    case StatType.CashFlow:
      return 0.8;
    case StatType.Runway:
      return 0.9;
    case StatType.BreakEven:
      return 0.85;
    case StatType.CashForecast:
      return 0.85;
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
