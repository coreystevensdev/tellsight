'use client';

import { useState } from 'react';
import { Bell, BellOff, Pencil, Trash2, Loader2, AlertCircle, X, Plus } from 'lucide-react';
import type { AlertRuleKind, AlertRuleInput } from 'shared/schemas';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export type AlertRule = AlertRuleInput & {
  id: number;
  muteUntil: string | null;
  createdAt: string;
};

const KIND_ORDER: AlertRuleKind[] = [
  'runway_runs_short',
  'margin_drops',
  'cash_burn_spikes',
  'breakeven_gap_widens',
  'anomaly_fires',
];

const KIND_META: Record<AlertRuleKind, { label: string; help: string }> = {
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

// AlertRuleInput, not a Pick<AlertRule, ...> projection, Pick collapses a
// discriminated union's members into one shape and switching on `kind` would
// no longer narrow `threshold`.
function describeThreshold(rule: AlertRuleInput): string {
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

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function isMuted(rule: AlertRule): boolean {
  return rule.muteUntil !== null && new Date(rule.muteUntil) > new Date();
}

interface FormState {
  kind: AlertRuleKind;
  numericValue: string;
  confidence: 'low' | 'moderate' | 'high';
}

function emptyForm(): FormState {
  return { kind: 'runway_runs_short', numericValue: '3', confidence: 'moderate' };
}

function formToPayload(form: FormState): AlertRuleInput {
  if (form.kind === 'anomaly_fires') {
    return { kind: 'anomaly_fires', threshold: { confidence: form.confidence } };
  }
  const value = Number(form.numericValue);
  const bounded = Number.isFinite(value) ? value : 0;
  if (form.kind === 'runway_runs_short') {
    return { kind: 'runway_runs_short', threshold: { months: bounded } };
  }
  return { kind: form.kind, threshold: { percent: bounded } };
}

function ruleToForm(rule: AlertRule): FormState {
  const base = emptyForm();
  if (rule.kind === 'anomaly_fires') {
    return { ...base, kind: rule.kind, confidence: rule.threshold.confidence };
  }
  if (rule.kind === 'runway_runs_short') {
    return { ...base, kind: rule.kind, numericValue: String(rule.threshold.months) };
  }
  return { ...base, kind: rule.kind, numericValue: String(rule.threshold.percent) };
}

interface Props {
  initial: AlertRule[];
}

export default function AlertRules({ initial }: Props) {
  const [rules, setRules] = useState<AlertRule[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  function reportError(err: unknown, fallback: string) {
    if (err instanceof ApiClientError && err.status === 403) {
      setError('Only organization owners can manage alert rules.');
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  function openCreateForm() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
    setError(null);
  }

  function openEditForm(rule: AlertRule) {
    setEditingId(rule.id);
    setForm(ruleToForm(rule));
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);
    const payload = formToPayload(form);

    try {
      if (editingId != null) {
        const { data } = await apiClient<AlertRule>(`/org/alert-rules/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setRules((prev) => prev.map((r) => (r.id === editingId ? data : r)));
      } else {
        const { data } = await apiClient<AlertRule>('/org/alert-rules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setRules((prev) => [data, ...prev]);
      }
      closeForm();
    } catch (err) {
      reportError(err, editingId != null ? 'Failed to update alert rule' : 'Failed to create alert rule');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleEnabled(rule: AlertRule) {
    setBusyId(rule.id);
    setError(null);
    try {
      const { data } = await apiClient<AlertRule>(`/org/alert-rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ kind: rule.kind, threshold: rule.threshold, enabled: !rule.enabled }),
      });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? data : r)));
    } catch (err) {
      reportError(err, 'Failed to update alert rule');
    } finally {
      setBusyId(null);
    }
  }

  async function unmuteRule(rule: AlertRule) {
    setBusyId(rule.id);
    setError(null);
    try {
      const { data } = await apiClient<AlertRule>(`/org/alert-rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({ kind: rule.kind, threshold: rule.threshold, muteUntil: null }),
      });
      setRules((prev) => prev.map((r) => (r.id === rule.id ? data : r)));
    } catch (err) {
      reportError(err, 'Failed to unmute alert rule');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteRule(id: number) {
    setBusyId(id);
    setError(null);
    try {
      await apiClient(`/org/alert-rules/${id}`, { method: 'DELETE' });
      setRules((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      reportError(err, 'Failed to delete alert rule');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Alerts</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Get notified between weekly digests when a number crosses a threshold you care about.
            </p>
          </div>
          {!formOpen && rules.length > 0 && (
            <button
              onClick={openCreateForm}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              New rule
            </button>
          )}
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="flex-1 text-sm text-destructive">{error}</p>
            <button
              onClick={() => setError(null)}
              className="shrink-0 rounded-md p-0.5 text-destructive/60 transition-colors hover:text-destructive"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {formOpen && (
          <form
            onSubmit={submitForm}
            className="mb-6 space-y-4 rounded-lg border border-border bg-card p-5"
          >
            <div>
              <label htmlFor="rule-kind" className="block text-sm font-medium text-foreground">
                Alert type
              </label>
              <select
                id="rule-kind"
                value={form.kind}
                onChange={(e) => setForm({ ...emptyForm(), kind: e.target.value as AlertRuleKind })}
                disabled={submitting}
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
              >
                {KIND_ORDER.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_META[kind].label}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">{KIND_META[form.kind].help}</p>
            </div>

            {form.kind === 'anomaly_fires' ? (
              <div>
                <label htmlFor="rule-confidence" className="block text-sm font-medium text-foreground">
                  Minimum confidence
                </label>
                <select
                  id="rule-confidence"
                  value={form.confidence}
                  onChange={(e) => setForm({ ...form, confidence: e.target.value as FormState['confidence'] })}
                  disabled={submitting}
                  className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                >
                  <option value="low">Low</option>
                  <option value="moderate">Moderate</option>
                  <option value="high">High</option>
                </select>
              </div>
            ) : (
              <div>
                <label htmlFor="rule-value" className="block text-sm font-medium text-foreground">
                  {form.kind === 'runway_runs_short' ? 'Months' : 'Percent'}
                </label>
                <input
                  id="rule-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={form.kind === 'runway_runs_short' ? 1 : 0.5}
                  value={form.numericValue}
                  onChange={(e) => setForm({ ...form, numericValue: e.target.value })}
                  disabled={submitting}
                  className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
                />
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={submitting}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Saving…' : editingId != null ? 'Save changes' : 'Create rule'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                disabled={submitting}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {rules.length === 0 && !formOpen ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/30 px-8 py-16 text-center">
            <Bell className="mb-1 h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No alert rules yet</p>
            <p className="max-w-[320px] text-sm text-muted-foreground">
              Set a threshold on runway, margin, burn rate, break-even, or an anomaly, and we&apos;ll
              email you the moment it crosses.
            </p>
            <button
              onClick={openCreateForm}
              className="mt-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Create your first alert rule
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={cn(
                  'flex items-center justify-between gap-4 rounded-lg border px-5 py-4',
                  rule.enabled ? 'border-border bg-card' : 'border-border/60 bg-muted/30',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{KIND_META[rule.kind].label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {describeThreshold(rule)} &middot; created {formatDate(rule.createdAt)}
                  </p>
                  {isMuted(rule) && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning">
                      <BellOff className="h-3 w-3" aria-hidden="true" />
                      Muted until {formatDate(rule.muteUntil!)}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {isMuted(rule) && (
                    <button
                      onClick={() => unmuteRule(rule)}
                      disabled={busyId === rule.id}
                      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === rule.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Unmute now'}
                    </button>
                  )}
                  <button
                    onClick={() => toggleEnabled(rule)}
                    disabled={busyId === rule.id}
                    aria-pressed={rule.enabled}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      rule.enabled
                        ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                        : 'border-border bg-background text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {busyId === rule.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : rule.enabled ? 'On' : 'Off'}
                  </button>
                  <button
                    onClick={() => openEditForm(rule)}
                    disabled={busyId === rule.id}
                    className="rounded-md border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Edit alert rule"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    disabled={busyId === rule.id}
                    className="rounded-md border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label="Delete alert rule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-8 border-t border-border pt-6">
          <a href="/dashboard" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
            &larr; Back to dashboard
          </a>
        </div>
      </div>
    </div>
  );
}
