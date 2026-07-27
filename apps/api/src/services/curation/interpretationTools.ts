import { dataRowsQueries, orgsQueries, statCorrectionsQueries, digestHistoryQueries } from '../../db/queries/index.js';
import { withRlsContext } from '../../lib/rls.js';
import type { ToolDefinition } from '../aiInterpretation/claudeClient.js';
import { findMatchingStat, resolveStatByType, statInstanceId } from './computation.js';
import { scoringConfig } from './scoring.js';
import { StatType } from './types.js';
import type { ComputedStat, IdentifiedStat } from './types.js';

// Statement shape for the future Q&A orchestrator: never derived from a
// request or session, matching the explicit-context idiom resolveCitation
// and evaluateOrg already use.
export interface ToolContext {
  orgId: number;
  isAdmin: boolean;
  datasetId: number;
}

// statTypes whose `details` already carry trend/comparison signal. total/average
// are deliberately absent so the model can't request a bare number through
// either tool -- both are interpretation-biased by construction, not lookup tools.
export const TREND_CARRYING_STAT_TYPES = [
  StatType.Trend,
  StatType.YearOverYear,
  StatType.MarginTrend,
  StatType.SeasonalProjection,
  StatType.CashFlow,
  StatType.Runway,
  StatType.BreakEven,
  StatType.CashForecast,
] as const;

export type TrendCarryingStatType = (typeof TREND_CARRYING_STAT_TYPES)[number];

// These have no category axis (computeCashFlow/Runway/BreakEven/CashForecast
// all emit a single org-wide stat), so a category the model supplies for one
// of them is ignored rather than treated as a (mismatching) filter.
const ORG_WIDE_STAT_TYPES = new Set<TrendCarryingStatType>([
  StatType.CashFlow,
  StatType.Runway,
  StatType.BreakEven,
  StatType.CashForecast,
]);

// Resolves what category to actually match on for a given statType + the
// category the caller supplied. `ok: false` means a category-scoped statType
// (Trend, YearOverYear, MarginTrend, SeasonalProjection) had no category --
// matching without one would silently return an arbitrary category's stat.
function resolveCategoryScope(
  statType: TrendCarryingStatType,
  category: string | undefined,
): { ok: true; category: string | undefined } | { ok: false } {
  if (ORG_WIDE_STAT_TYPES.has(statType)) return { ok: true, category: undefined };
  if (category === undefined) return { ok: false };
  return { ok: true, category };
}

export interface GetMetricWithTrendInput {
  statType: TrendCarryingStatType;
  category?: string;
}

export const GET_METRIC_WITH_TREND_TOOL: ToolDefinition = {
  name: 'get_metric_with_trend',
  description:
    'Get one metric that already carries a trend or comparison (growth, margin direction, runway, cash forecast), never a bare total. Returns null if nothing matches.',
  inputSchema: {
    type: 'object',
    properties: {
      statType: { type: 'string', enum: [...TREND_CARRYING_STAT_TYPES] },
      category: { type: 'string', description: 'Category to scope the metric to, e.g. "Sales". Omit for org-wide stats like runway or cash forecast.' },
    },
    required: ['statType'],
  },
};

async function loadRowsAndExclusions(ctx: ToolContext): Promise<{ rows: Awaited<ReturnType<typeof dataRowsQueries.getRowsByDataset>>; excludedStatIds: Set<string> }> {
  const [rows, excludedIds] = await withRlsContext(ctx.orgId, ctx.isAdmin, (tx) =>
    Promise.all([
      dataRowsQueries.getRowsByDataset(ctx.orgId, ctx.datasetId, tx),
      statCorrectionsQueries.getActiveCorrectionStatIds(ctx.orgId, tx),
    ]),
  );
  return { rows, excludedStatIds: new Set(excludedIds) };
}

async function loadFinancials(orgId: number) {
  const profile = await orgsQueries.getBusinessProfile(orgId);
  return profile
    ? { cashOnHand: profile.cashOnHand, cashAsOfDate: profile.cashAsOfDate, monthlyFixedCosts: profile.monthlyFixedCosts }
    : null;
}

export async function getMetricWithTrend(
  input: GetMetricWithTrendInput,
  ctx: ToolContext,
): Promise<IdentifiedStat | null> {
  if (!Number.isInteger(ctx.datasetId) || ctx.datasetId <= 0) return null;
  const scope = resolveCategoryScope(input.statType, input.category);
  if (!scope.ok) return null;

  const [{ rows, excludedStatIds }, financials] = await Promise.all([
    loadRowsAndExclusions(ctx),
    loadFinancials(ctx.orgId),
  ]);

  const stat = resolveStatByType(rows, ctx.datasetId, input.statType, scope.category, {
    trendMinPoints: scoringConfig.thresholds.trendMinDataPoints,
    financials,
  });

  if (!stat || excludedStatIds.has(stat.id)) return null;
  return stat;
}

export interface CompareToPriorPeriodsInput {
  statType: TrendCarryingStatType;
  category?: string;
  periodsBack?: number;
}

export const COMPARE_TO_PRIOR_PERIODS_TOOL: ToolDefinition = {
  name: 'compare_to_prior_periods',
  description:
    'Compare a metric to its value in prior weekly digests, returning the current value plus a history series. Marks hasHistory: false rather than fabricating a trend when the org has too little digest history.',
  inputSchema: {
    type: 'object',
    properties: {
      statType: { type: 'string', enum: [...TREND_CARRYING_STAT_TYPES] },
      category: { type: 'string', description: 'Category to scope the metric to, e.g. "Sales". Omit for org-wide stats like runway or cash forecast.' },
      periodsBack: { type: 'integer', minimum: 2, maximum: 8, description: 'How many prior weekly digests to compare against. Defaults to 4.' },
    },
    required: ['statType'],
  },
};

export interface PriorPeriodPoint {
  weekStart: string;
  value: number;
}

export type CompareToPriorPeriodsResult =
  | { current: IdentifiedStat; hasHistory: false }
  | { current: IdentifiedStat; hasHistory: true; priorPeriods: PriorPeriodPoint[] };

const DEFAULT_PERIODS_BACK = 4;

// inputSchema's min/max are advisory to the model, not an enforced runtime
// contract, so a caller passing an out-of-range or non-finite value still
// gets a sane LIMIT rather than whatever it sent straight into the query.
function clampPeriodsBack(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PERIODS_BACK;
  return Math.min(8, Math.max(2, Math.trunc(value as number)));
}

function findMatchInKeyStats(
  keyStats: ComputedStat[],
  statType: TrendCarryingStatType,
  category: string | undefined,
): ComputedStat | null {
  return findMatchingStat(keyStats, statType, category);
}

export async function compareToPriorPeriods(
  input: CompareToPriorPeriodsInput,
  ctx: ToolContext,
): Promise<CompareToPriorPeriodsResult | null> {
  if (!Number.isInteger(ctx.datasetId) || ctx.datasetId <= 0) return null;
  const scope = resolveCategoryScope(input.statType, input.category);
  if (!scope.ok) return null;

  const periodsBack = clampPeriodsBack(input.periodsBack);

  const [{ rows, excludedStatIds }, financials, digests] = await Promise.all([
    loadRowsAndExclusions(ctx),
    loadFinancials(ctx.orgId),
    withRlsContext(ctx.orgId, ctx.isAdmin, (tx) => digestHistoryQueries.getTrailingDigests(ctx.orgId, periodsBack, tx)),
  ]);

  const current = resolveStatByType(rows, ctx.datasetId, input.statType, scope.category, {
    trendMinPoints: scoringConfig.thresholds.trendMinDataPoints,
    financials,
  });

  if (!current || excludedStatIds.has(current.id)) return null;

  const priorPeriods: PriorPeriodPoint[] = [];
  for (const digest of digests) {
    const match = findMatchInKeyStats(digest.keyStats, input.statType, scope.category);
    if (!match || excludedStatIds.has(statInstanceId(match, ctx.datasetId))) continue;
    priorPeriods.push({ weekStart: digest.weekStart.toISOString(), value: match.value });
  }

  // hasHistory reflects whether this specific metric showed up in any
  // trailing digest, not just whether the org has enough digest rows --
  // key_stats is each week's curated top-N, not a full stat archive, so a
  // metric can easily be absent from every trailing digest even with plenty
  // of digest history overall.
  if (priorPeriods.length === 0) return { current, hasHistory: false };
  return { current, hasHistory: true, priorPeriods };
}
