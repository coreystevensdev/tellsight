'use client';

import { useEffect, useState } from 'react';
import { apiClient, ApiClientError } from '@/lib/api-client';
import type { OrgFinancials } from 'shared/types';
import { cn } from '@/lib/utils';

function formatCurrency(n: number | undefined | null): string {
  if (n == null) return '';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function parseCurrency(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatDateForInput(iso: string | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10); // YYYY-MM-DD from ISO
}

export default function FinancialsForm() {
  const [loading, setLoading] = useState(true);
  const [cash, setCash] = useState('');
  const [started, setStarted] = useState('');
  const [asOf, setAsOf] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient<OrgFinancials>('/org/financials');
        setCash(formatCurrency(res.data.cashOnHand));
        setAsOf(formatDateForInput(res.data.cashAsOfDate));
        setStarted(formatDateForInput(res.data.businessStartedDate));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not load financials.';
        setFlash({ kind: 'error', message: msg });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const parsedCash = parseCurrency(cash);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFlash(null);

    const updates: Record<string, unknown> = {};
    if (parsedCash != null && parsedCash > 0) updates.cashOnHand = parsedCash;
    if (started) updates.businessStartedDate = started;
    // cashAsOfDate: if a cash value is being saved, stamp it now. Otherwise preserve.
    if (updates.cashOnHand != null) updates.cashAsOfDate = new Date().toISOString();

    try {
      await apiClient('/org/financials', {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      setFlash({ kind: 'ok', message: 'Financial baseline updated.' });
      if (updates.cashAsOfDate) setAsOf(formatDateForInput(updates.cashAsOfDate as string));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) {
        setFlash({ kind: 'error', message: 'Only organization owners can edit the financial baseline.' });
      } else {
        const msg = err instanceof Error ? err.message : 'Could not save.';
        setFlash({ kind: 'error', message: msg });
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Financial baseline</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These values power runway and break-even analysis. Only organization owners can update them.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label htmlFor="cash" className="block text-sm font-medium text-foreground">
            Current cash on hand
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Across all operating accounts. Saving updates the &ldquo;as of&rdquo; date to today.
          </p>
          <input
            id="cash"
            type="text"
            inputMode="decimal"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            onBlur={() => {
              const n = parseCurrency(cash);
              if (n != null) setCash(formatCurrency(n));
            }}
            onFocus={() => {
              const n = parseCurrency(cash);
              if (n != null) setCash(String(n));
            }}
            disabled={submitting}
            placeholder="$0"
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          {asOf && (
            <p className="mt-1.5 text-xs text-muted-foreground">Last updated {asOf}</p>
          )}
        </div>

        <div>
          <label htmlFor="started" className="block text-sm font-medium text-foreground">
            Business started
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Optional. Enables growth-rate comparisons over your operating history.
          </p>
          <input
            id="started"
            type="date"
            value={started}
            onChange={(e) => setStarted(e.target.value)}
            disabled={submitting}
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={submitting}
            className={cn(
              'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
          <a href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </a>
        </div>

        {flash && (
          <p
            role={flash.kind === 'error' ? 'alert' : 'status'}
            className={cn('text-sm', flash.kind === 'error' ? 'text-destructive' : 'text-primary')}
          >
            {flash.message}
          </p>
        )}
      </form>

      <div className="mt-8 border-t border-border pt-6">
        <a href="/dashboard" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          &larr; Back to dashboard
        </a>
      </div>
    </div>
  );
}
