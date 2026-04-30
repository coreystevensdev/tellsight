'use client';

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CashBalanceStaleBannerProps {
  cashAsOfDate: string | null | undefined;
  now?: Date;
  onUpdate: (value: number) => Promise<void>;
  className?: string;
}

const DISMISS_KEY = 'cashBalanceStaleBanner:dismissed';

function ageInDays(asOf: Date, now: Date): number {
  return Math.floor((now.getTime() - asOf.getTime()) / (24 * 60 * 60 * 1000));
}

function initialDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(DISMISS_KEY) === '1';
}

/**
 * Surfaces when cash balance is more than 30 days old. Session-scoped dismissal
 * the nudge re-appears next visit because fresh data matters more than UI quiet.
 *
 * Suppressed entirely at 180+ days: runway is also suppressed at that age, so the
 * banner would point to a feature that isn't rendering.
 */
export function CashBalanceStaleBanner({
  cashAsOfDate,
  now = new Date(),
  onUpdate,
  className,
}: CashBalanceStaleBannerProps) {
  const [dismissed, setDismissed] = useState(initialDismissed);
  const [inlineOpen, setInlineOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!cashAsOfDate || dismissed) return null;

  const asOf = new Date(cashAsOfDate);
  if (Number.isNaN(asOf.getTime())) return null;

  const age = ageInDays(asOf, now);
  if (age <= 30) return null;
  if (age > 180) return null;

  const parsed = Number(raw.replace(/[^0-9.]/g, ''));
  const valid = Number.isFinite(parsed) && parsed > 0;
  const urgent = age > 90;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await onUpdate(parsed);
      setInlineOpen(false);
      setRaw('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleDismiss() {
    window.sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-lg border p-4',
        urgent
          ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
          : 'border-border bg-muted/40',
        className,
      )}
    >
      <AlertTriangle
        className={cn('h-5 w-5 shrink-0', urgent ? 'text-amber-600' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-[14rem]">
        <p className="text-sm font-medium text-foreground">
          {urgent
            ? `Cash balance is ${age} days old, runway confidence is low`
            : 'Update your cash balance'}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {urgent
            ? 'An updated balance sharpens the runway estimate significantly.'
            : 'Runway accuracy depends on fresh data.'}
        </p>

        {inlineOpen && (
          <form onSubmit={handleSubmit} className="mt-3 flex gap-2">
            <input
              type="text"
              inputMode="decimal"
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                if (error) setError(null);
              }}
              placeholder="$0"
              aria-label="Updated cash balance"
              disabled={submitting}
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!valid || submitting}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Save'}
            </button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!inlineOpen && (
          <button
            type="button"
            onClick={() => setInlineOpen(true)}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Update
          </button>
        )}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss banner"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
