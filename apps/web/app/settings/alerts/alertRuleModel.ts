import type { AlertRuleInput, AlertRuleKind } from 'shared/schemas';

export type AlertRule = AlertRuleInput & {
  id: number;
  muteUntil: string | null;
  createdAt: string;
};

export const KIND_ORDER: AlertRuleKind[] = [
  'runway_runs_short',
  'margin_drops',
  'cash_burn_spikes',
  'breakeven_gap_widens',
  'anomaly_fires',
];

export const KIND_META: Record<AlertRuleKind, { label: string; help: string }> = {
  runway_runs_short: {
    label: 'Runway runs short',
    help: 'Fires when your cash runway drops below this many months.',
  },
  margin_drops: {
    label: 'Margin drops',
    help: 'Fires when your profit margin falls by more than this many percentage points.',
  },
  cash_burn_spikes: {
    label: 'Cash burn spikes',
    help: 'Fires when your monthly burn rate increases by more than this percent.',
  },
  breakeven_gap_widens: {
    label: 'Break-even gap widens',
    help: 'Fires when the gap between revenue and break-even grows by more than this percent.',
  },
  anomaly_fires: {
    label: 'Anomaly detected',
    help: 'Fires when an unusual data point is flagged at or above this confidence level.',
  },
};

export interface AlertRuleFormState {
  kind: AlertRuleKind;
  numericValue: string;
  confidence: 'low' | 'moderate' | 'high';
}

export function emptyAlertRuleForm(): AlertRuleFormState {
  return { kind: 'runway_runs_short', numericValue: '3', confidence: 'moderate' };
}

export function formToPayload(form: AlertRuleFormState): AlertRuleInput {
  if (form.kind === 'anomaly_fires') {
    return { kind: 'anomaly_fires', threshold: { confidence: form.confidence } };
  }
  const value = Number(form.numericValue);
  if (form.kind === 'runway_runs_short') {
    return { kind: 'runway_runs_short', threshold: { months: value } };
  }
  return { kind: form.kind, threshold: { percent: value } };
}

export function ruleToForm(rule: AlertRule): AlertRuleFormState {
  const base = emptyAlertRuleForm();
  if (rule.kind === 'anomaly_fires') {
    return { ...base, kind: rule.kind, confidence: rule.threshold.confidence };
  }
  if (rule.kind === 'runway_runs_short') {
    return { ...base, kind: rule.kind, numericValue: String(rule.threshold.months) };
  }
  return { ...base, kind: rule.kind, numericValue: String(rule.threshold.percent) };
}

export function describeThreshold(rule: AlertRuleInput): string {
  switch (rule.kind) {
    case 'runway_runs_short':
      return `Below ${rule.threshold.months} months`;
    case 'margin_drops':
      return `Drops more than ${rule.threshold.percent}pp`;
    case 'cash_burn_spikes':
      return `Increases more than ${rule.threshold.percent}%`;
    case 'breakeven_gap_widens':
      return `Widens more than ${rule.threshold.percent}%`;
    case 'anomaly_fires':
      return `Confidence at or above ${rule.threshold.confidence}`;
  }
}

export function formatAlertDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function isAlertMuted(rule: AlertRule): boolean {
  return rule.muteUntil !== null && new Date(rule.muteUntil) > new Date();
}
