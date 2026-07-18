import type { AlertRuleKind } from 'shared/schemas';

export const RULE_KIND_LABELS: Record<AlertRuleKind, string> = {
  runway_runs_short: 'Your cash runway is running short',
  margin_drops: 'Your profit margin has dropped',
  cash_burn_spikes: 'Your cash burn rate has spiked',
  breakeven_gap_widens: 'Your break-even gap has widened',
  anomaly_fires: 'An unusual transaction pattern was detected',
};

// Noun-phrase form for the CAN-SPAM "reason for receipt" line and the mute
// confirmation page, distinct from the headline sentences above ("alert rule
// for cash runway", not "alert rule for Your cash runway is running short").
export const RULE_KIND_NOUN_LABELS: Record<AlertRuleKind, string> = {
  runway_runs_short: 'cash runway',
  margin_drops: 'profit margin',
  cash_burn_spikes: 'cash burn rate',
  breakeven_gap_widens: 'break-even gap',
  anomaly_fires: 'unusual transactions',
};
