'use client';

import { cn } from '@/lib/utils';
import { BackLink } from '@/components/common/BackLink';
import { formatCurrency, parseCurrency, useFinancialsForm } from './useFinancialsForm';

export default function FinancialsForm() {
  const financials = useFinancialsForm();

  if (financials.loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <BackLink />
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-medium text-foreground">Financial baseline</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These values power runway and break-even analysis. Only organization owners can update them.
        </p>
      </div>

      <form onSubmit={financials.saveFinancials} className="space-y-5">
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
            value={financials.cash}
            onChange={(event) => financials.setCash(event.target.value)}
            onBlur={() => {
              const amount = parseCurrency(financials.cash);
              if (amount != null) financials.setCash(formatCurrency(amount));
            }}
            onFocus={() => {
              const amount = parseCurrency(financials.cash);
              if (amount != null) financials.setCash(String(amount));
            }}
            disabled={financials.submitting}
            placeholder="$0"
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          {financials.asOf && (
            <p className="mt-1.5 text-xs text-muted-foreground">Last updated {financials.asOf}</p>
          )}
        </div>

        <div>
          <label htmlFor="fixed-costs" className="block text-sm font-medium text-foreground">
            Monthly fixed costs
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Rent, salaries, software subscriptions, insurance. Rough estimates are fine, you can update anytime.
          </p>
          <input
            id="fixed-costs"
            type="text"
            inputMode="decimal"
            value={financials.fixedCosts}
            onChange={(event) => financials.setFixedCosts(event.target.value)}
            onBlur={() => {
              const amount = parseCurrency(financials.fixedCosts);
              if (amount != null) financials.setFixedCosts(formatCurrency(amount));
            }}
            onFocus={() => {
              const amount = parseCurrency(financials.fixedCosts);
              if (amount != null) financials.setFixedCosts(String(amount));
            }}
            disabled={financials.submitting}
            placeholder="$0"
            aria-invalid={
              financials.parsedFixedCosts != null && financials.parsedFixedCosts > 9_999_999
                ? 'true'
                : undefined
            }
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
          {financials.parsedFixedCosts != null && financials.parsedFixedCosts > 9_999_999 && (
            <p role="alert" className="mt-1.5 text-xs text-destructive">
              Must be $9,999,999 or less.
            </p>
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
            value={financials.started}
            onChange={(event) => financials.setStarted(event.target.value)}
            disabled={financials.submitting}
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={financials.submitting}
            className={cn(
              'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {financials.submitting ? 'Saving…' : 'Save changes'}
          </button>
          <a href="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            Cancel
          </a>
        </div>

        {financials.flash && (
          <p
            role={financials.flash.kind === 'error' ? 'alert' : 'status'}
            className={cn(
              'text-sm',
              financials.flash.kind === 'error' ? 'text-destructive' : 'text-primary',
            )}
          >
            {financials.flash.message}
          </p>
        )}
      </form>
    </div>
  );
}
