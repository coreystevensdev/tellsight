import { z } from 'zod';

export const StatType = {
  Total: 'total',
  Average: 'average',
  Trend: 'trend',
  Anomaly: 'anomaly',
  CategoryBreakdown: 'category_breakdown',
  YearOverYear: 'year_over_year',
  MarginTrend: 'margin_trend',
  SeasonalProjection: 'seasonal_projection',
  CashFlow: 'cash_flow',
  Runway: 'runway',
  BreakEven: 'break_even',
  CashForecast: 'cash_forecast',
} as const;

export type StatType = (typeof StatType)[keyof typeof StatType];

// typed detail shapes per stat — the contract between computation and scoring layers

export interface TotalDetails {
  scope: string;
  count: number;
}

export interface AverageDetails {
  scope: string;
  median: number;
}

export interface TrendDetails {
  slope: number;
  intercept: number;
  growthPercent: number;
  dataPoints: number;
  firstValue: number;
  lastValue: number;
}

export interface AnomalyDetails {
  direction: 'above' | 'below';
  zScore: number;
  iqrBounds: { lower: number; upper: number };
  deviation: number;
}

export interface CategoryBreakdownDetails {
  percentage: number;
  absoluteTotal: number;
  transactionCount: number;
  min: number;
  max: number;
}

export interface YearOverYearDetails {
  currentYear: number;
  priorYear: number;
  currentYearLabel: string;
  priorYearLabel: string;
  changePercent: number;
  month: string;
}

export interface MarginTrendDetails {
  recentMarginPercent: number;
  priorMarginPercent: number;
  direction: 'expanding' | 'shrinking' | 'stable';
  revenueGrowthPercent: number;
  expenseGrowthPercent: number;
}

export interface SeasonalProjectionDetails {
  projectedMonth: string;
  projectedAmount: number;
  basisMonths: string[];
  basisValues: number[];
  confidence: 'high' | 'moderate' | 'low';
}

// Net cash flow over a trailing window. Negative = burning, positive = surplus.
// MonthlyNet is signed — the prompt layer interprets direction for the owner.
// `break_even` isn't emitted — computation.ts applies a 5%-of-avg-revenue
// suppression band (see `0.05 * avgMonthlyRevenue` in computeCashFlow) that
// returns [] instead of labeling the stat break-even — so the literal is
// intentionally absent from the union.
export interface CashFlowDetails {
  monthlyNet: number;
  trailingMonths: number;
  direction: 'burning' | 'surplus';
  monthsBurning: number;
  recentMonths: { month: string; revenue: number; expenses: number; net: number }[];
}

// Runway in months at current burn. Only emitted when CashFlow.direction === 'burning'
// AND owner has provided a fresh cashOnHand. Confidence softens framing on stale data.
export interface RunwayDetails {
  cashOnHand: number;
  monthlyNet: number; // signed — will be negative (burning)
  runwayMonths: number;
  cashAsOfDate: string; // ISO
  confidence: 'high' | 'moderate' | 'low';
}

// Monthly revenue needed to cover fixed costs at the current margin. Emitted only
// when MarginTrend is present, fixed costs are set, and margin is at least 2%.
// `gap` is signed — positive means revenue is below break-even (still burning);
// negative means revenue already covers fixed costs.
export interface BreakEvenDetails {
  monthlyFixedCosts: number;
  marginPercent: number;
  breakEvenRevenue: number;
  currentMonthlyRevenue: number;
  gap: number;
  confidence: 'high' | 'moderate' | 'low';
}

// One projected month in the cash-flow forecast. `projectedNet` is the regression's
// prediction for net cash flow in that month; `projectedBalance` is the cumulative
// running balance starting from today's cashOnHand.
export interface ProjectedMonth {
  month: string; // YYYY-MM
  projectedNet: number;
  projectedBalance: number;
}

// Three-month forward cash forecast. Linear regression on recent net change,
// with a rolling-mean fallback when the regression is degenerate (flat input).
// `crossesZeroAtMonth` is 1-indexed — the first projected month where the running
// balance dips below zero — or null when balance holds across the window.
export interface CashForecastDetails {
  startingBalance: number;
  asOfDate: string; // ISO
  method: 'linear_regression' | 'rolling_mean';
  slope: number;
  intercept: number;
  basisMonths: string[];
  basisValues: number[];
  projectedMonths: ProjectedMonth[];
  crossesZeroAtMonth: number | null;
  confidence: 'high' | 'moderate' | 'low';
}

interface BaseComputedStat {
  category: string | null;
  value: number;
  comparison?: number;
}

export interface TotalStat extends BaseComputedStat {
  statType: 'total';
  details: TotalDetails;
}

export interface AverageStat extends BaseComputedStat {
  statType: 'average';
  details: AverageDetails;
}

export interface TrendStat extends BaseComputedStat {
  statType: 'trend';
  details: TrendDetails;
}

export interface AnomalyStat extends BaseComputedStat {
  statType: 'anomaly';
  details: AnomalyDetails;
}

export interface CategoryBreakdownStat extends BaseComputedStat {
  statType: 'category_breakdown';
  details: CategoryBreakdownDetails;
}

export interface YearOverYearStat extends BaseComputedStat {
  statType: 'year_over_year';
  details: YearOverYearDetails;
}

export interface MarginTrendStat extends BaseComputedStat {
  statType: 'margin_trend';
  details: MarginTrendDetails;
}

export interface SeasonalProjectionStat extends BaseComputedStat {
  statType: 'seasonal_projection';
  details: SeasonalProjectionDetails;
}

export interface CashFlowStat extends BaseComputedStat {
  statType: 'cash_flow';
  details: CashFlowDetails;
}

export interface RunwayStat extends BaseComputedStat {
  statType: 'runway';
  details: RunwayDetails;
}

export interface BreakEvenStat extends BaseComputedStat {
  statType: 'break_even';
  details: BreakEvenDetails;
}

export interface CashForecastStat extends BaseComputedStat {
  statType: 'cash_forecast';
  details: CashForecastDetails;
}

export type ComputedStat =
  | TotalStat
  | AverageStat
  | TrendStat
  | AnomalyStat
  | CategoryBreakdownStat
  | YearOverYearStat
  | MarginTrendStat
  | SeasonalProjectionStat
  | CashFlowStat
  | RunwayStat
  | BreakEvenStat
  | CashForecastStat;

export interface ScoredInsight {
  stat: ComputedStat;
  score: number;
  breakdown: {
    novelty: number;
    actionability: number;
    specificity: number;
  };
}

export const scoringConfigSchema = z.object({
  version: z.string(),
  topN: z.number().int().positive(),
  weights: z.object({
    novelty: z.number().min(0).max(1),
    actionability: z.number().min(0).max(1),
    specificity: z.number().min(0).max(1),
  }).refine(
    (w) => Math.abs(w.novelty + w.actionability + w.specificity - 1.0) < 0.001,
    { message: 'Weights must sum to 1.0' },
  ),
  thresholds: z.object({
    anomalyZScore: z.number().positive(),
    trendMinDataPoints: z.number().int().min(2),
    significantChangePercent: z.number().positive(),
  }),
});

export type ScoringConfig = z.infer<typeof scoringConfigSchema>;

export const transparencyMetadataSchema = z.object({
  statTypes: z.array(z.string()),
  categoryCount: z.number(),
  insightCount: z.number(),
  scoringWeights: z.object({
    novelty: z.number(),
    actionability: z.number(),
    specificity: z.number(),
  }),
  promptVersion: z.string(),
  generatedAt: z.string(),
});

export type TransparencyMetadata = z.infer<typeof transparencyMetadataSchema>;

// Split into system + user so the system half can be sent with prompt-cache
// control on Anthropic. Older single-file templates (v1-v1.5, v1-digest) load
// entirely into `user` with `system: ''` — the LlmProvider treats empty
// system as "no caching, send only user message".
export interface AssembledContext {
  system: string;
  user: string;
  metadata: TransparencyMetadata;
}
