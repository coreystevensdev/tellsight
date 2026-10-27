import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { AlertRuleKind } from 'shared/schemas';

import {
  emptyAlertRuleForm,
  KIND_META,
  KIND_ORDER,
  type AlertRuleFormState,
} from './alertRuleModel';

interface AlertRuleFormProps {
  form: AlertRuleFormState;
  setForm: Dispatch<SetStateAction<AlertRuleFormState>>;
  editing: boolean;
  submitting: boolean;
  numericInvalid: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}

export function AlertRuleForm({
  form,
  setForm,
  editing,
  submitting,
  numericInvalid,
  onSubmit,
  onCancel,
}: AlertRuleFormProps) {
  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="mb-6 space-y-4 border-t-2 border-border bg-card p-5"
    >
      <div>
        <label htmlFor="rule-kind" className="block text-sm font-medium text-foreground">
          Alert type
        </label>
        <select
          id="rule-kind"
          value={form.kind}
          onChange={(event) =>
            setForm({ ...emptyAlertRuleForm(), kind: event.target.value as AlertRuleKind })
          }
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
            onChange={(event) =>
              setForm({
                ...form,
                confidence: event.target.value as AlertRuleFormState['confidence'],
              })
            }
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
            min={form.kind === 'runway_runs_short' ? 1 : 0.5}
            step={form.kind === 'runway_runs_short' ? 1 : 0.5}
            value={form.numericValue}
            onChange={(event) => setForm({ ...form, numericValue: event.target.value })}
            disabled={submitting}
            aria-invalid={numericInvalid ? 'true' : undefined}
            aria-describedby={numericInvalid ? 'rule-value-error' : undefined}
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          {numericInvalid && (
            <p id="rule-value-error" role="alert" className="mt-1.5 text-xs text-destructive">
              Must be greater than 0.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
