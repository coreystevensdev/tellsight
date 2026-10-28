'use client';

import { Bell, BellOff, Pencil, Trash2, Loader2, AlertCircle, X, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BackLink } from '@/components/common/BackLink';
import { AlertRuleForm } from './AlertRuleForm';
import {
  describeThreshold,
  formatAlertDate,
  isAlertMuted,
  KIND_META,
  type AlertRule,
} from './alertRuleModel';
import { useAlertRules } from './useAlertRules';

export type { AlertRule } from './alertRuleModel';

interface Props {
  initial: AlertRule[];
}

export default function AlertRules({ initial }: Props) {
  const {
    rules,
    error,
    dismissError,
    formOpen,
    form,
    setForm,
    editingId,
    submitting,
    busyId,
    numericInvalid,
    openCreateForm,
    openEditForm,
    closeForm,
    submitForm,
    toggleEnabled,
    unmuteRule,
    deleteRule,
  } = useAlertRules(initial);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <BackLink />
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="font-serif text-2xl font-medium text-foreground">Alerts</h1>
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
              onClick={dismissError}
              className="shrink-0 rounded-md p-0.5 text-destructive/60 transition-colors hover:text-destructive"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {formOpen && (
          <AlertRuleForm
            form={form}
            setForm={setForm}
            editing={editingId !== null}
            submitting={submitting}
            numericInvalid={numericInvalid}
            onSubmit={submitForm}
            onCancel={closeForm}
          />
        )}

        {rules.length === 0 && !formOpen ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/30 px-8 py-16 text-center">
            <Bell className="mb-1 h-10 w-10 text-muted-foreground/40" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">No alert rules yet</p>
            <p className="max-w-[320px] text-sm text-muted-foreground">
              Set a threshold on runway, margin, burn rate, break-even, or an anomaly, and
              we&apos;ll email you the moment it crosses.
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
                  'flex items-center justify-between gap-4 border-t-2 px-5 py-4',
                  rule.enabled ? 'border-border bg-card' : 'border-border/60 bg-muted/30',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {KIND_META[rule.kind].label}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {describeThreshold(rule)} &middot; created {formatAlertDate(rule.createdAt)}
                  </p>
                  {isAlertMuted(rule) && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning">
                      <BellOff className="h-3 w-3" aria-hidden="true" />
                      Muted until {formatAlertDate(rule.muteUntil!)}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {isAlertMuted(rule) && (
                    <button
                      onClick={() => unmuteRule(rule)}
                      disabled={busyId === rule.id}
                      className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busyId === rule.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        'Unmute now'
                      )}
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
                    {busyId === rule.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : rule.enabled ? (
                      'On'
                    ) : (
                      'Off'
                    )}
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
      </div>
    </div>
  );
}
