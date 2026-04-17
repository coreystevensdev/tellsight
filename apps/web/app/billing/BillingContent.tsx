'use client';

import { useCallback, useState } from 'react';
import { useSubscription } from '@/lib/hooks/useSubscription';

export function BillingContent() {
  const { tier, isLoading } = useSubscription({ enabled: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCheckout = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/subscriptions?action=checkout', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? 'Failed to start checkout');
        return;
      }
      window.location.href = json.data.checkoutUrl;
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handlePortal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/subscriptions?action=portal', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? 'Failed to open portal');
        return;
      }
      window.location.href = json.data.portalUrl;
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-32 rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="mb-1 text-sm text-muted-foreground">Current Plan</div>
        <div className="text-xl font-semibold text-card-foreground">
          {tier === 'pro' ? 'Pro' : 'Free'}
        </div>
        {tier === 'free' && (
          <p className="mt-2 text-sm text-muted-foreground">
            Upgrade to Pro for full AI-powered business insights — no word limits, no blur.
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {tier === 'free' ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-6">
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-bold text-foreground">$29</span>
              <span className="text-sm text-muted-foreground">/month</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              or $19/mo billed annually
            </p>
            <ul className="mt-4 space-y-2 text-sm text-card-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-primary" aria-hidden="true">&#10003;</span>
                Full AI-powered analysis (no word limit)
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-primary" aria-hidden="true">&#10003;</span>
                100 AI summaries per month
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-primary" aria-hidden="true">&#10003;</span>
                Unlimited datasets and sharing
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-primary" aria-hidden="true">&#10003;</span>
                Export to PDF
              </li>
            </ul>
          </div>
          <button
            onClick={handleCheckout}
            disabled={loading}
            className="w-full rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Redirecting to checkout...' : 'Upgrade to Pro — $29/mo'}
          </button>
        </div>
      ) : (
        <button
          onClick={handlePortal}
          disabled={loading}
          className="w-full rounded-lg border border-border bg-muted px-4 py-3 font-medium text-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Redirecting...' : 'Manage Subscription'}
        </button>
      )}
    </div>
  );
}
