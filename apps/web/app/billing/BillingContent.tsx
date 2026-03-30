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
        <div className="h-32 rounded-lg bg-zinc-800" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-6">
        <div className="mb-1 text-sm text-zinc-400">Current Plan</div>
        <div className="text-xl font-semibold">
          {tier === 'pro' ? 'Pro' : 'Free'}
        </div>
        {tier === 'free' && (
          <p className="mt-2 text-sm text-zinc-400">
            Upgrade to Pro for full AI-powered business insights — no word limits, no blur.
          </p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {tier === 'free' ? (
        <button
          onClick={handleCheckout}
          disabled={loading}
          className="w-full rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Redirecting...' : 'Upgrade to Pro'}
        </button>
      ) : (
        <button
          onClick={handlePortal}
          disabled={loading}
          className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-3 font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Redirecting...' : 'Manage Subscription'}
        </button>
      )}
    </div>
  );
}
