import type { AlertRuleKind } from 'shared/schemas';

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
