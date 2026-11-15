import type { AlertRuleKind } from 'shared/schemas';
import type { ScoredInsight } from '../curation/types.js';
import { StatType } from '../curation/types.js';

export type ChartKind = 'runway' | 'cash-flow' | 'margin';

// breakeven_gap_widens and anomaly_fires have no dashboard chart equivalent
// today, so they're absent here rather than mapped to null explicitly.
const CHART_KIND_BY_RULE_KIND: Partial<Record<AlertRuleKind, ChartKind>> = {
  runway_runs_short: 'runway',
  cash_burn_spikes: 'cash-flow',
  margin_drops: 'margin',
};

export function getChartKindForRuleKind(ruleKind: AlertRuleKind): ChartKind | null {
  return CHART_KIND_BY_RULE_KIND[ruleKind] ?? null;
}

// The digest has no rule to map from, so it selects out of the week's scored
// pool instead. Both paths land on the same three charts.
const CHART_KIND_BY_STAT_TYPE: Partial<Record<StatType, ChartKind>> = {
  [StatType.Runway]: 'runway',
  [StatType.CashFlow]: 'cash-flow',
  [StatType.MarginTrend]: 'margin',
};

// rankInsights sorts on score alone, and a stable sort therefore leaves equal
// scores in whatever order the computation layer emitted them. The prompt can
// live with that, since it receives every stat in the top N; a chart cannot,
// because it picks one. Exactly one exact tie is reachable under the current
// weights, cash-flow burning two or more months against margin shrinking at
// 0.8400 each, and that pairing is close to the most important week the digest
// has to narrate. Runway leads for the same reason actionabilityScore calls it
// existential.
const TIEBREAK_ORDER: readonly ChartKind[] = ['runway', 'cash-flow', 'margin'];

/**
 * The chart for this week, or null when nothing in the pool has one. Reads the
 * pool rather than its top entry: a stat can outrank every chartable one and
 * still have no chart, Anomaly being the common case at 0.9 novelty.
 */
export function getChartKindForPool(pool: ScoredInsight[]): ChartKind | null {
  let best: { kind: ChartKind; score: number } | null = null;

  for (const { stat, score } of pool) {
    const kind = CHART_KIND_BY_STAT_TYPE[stat.statType];
    if (!kind) continue;

    if (best === null || score > best.score) {
      best = { kind, score };
      continue;
    }
    if (score === best.score && TIEBREAK_ORDER.indexOf(kind) < TIEBREAK_ORDER.indexOf(best.kind)) {
      best = { kind, score };
    }
  }

  return best?.kind ?? null;
}
