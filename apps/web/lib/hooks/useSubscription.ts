import useSWR from 'swr';
import type { SubscriptionTier } from 'shared/types';

import { attemptRefresh } from '@/lib/api-client';

interface UseSubscriptionOptions {
  enabled?: boolean;
  fallbackData?: SubscriptionTier;
}

interface UseSubscriptionResult {
  tier: SubscriptionTier | undefined;
  isPro: boolean;
  isLoading: boolean;
  mutate: () => Promise<void>;
}

async function fetchTier(url: string): Promise<SubscriptionTier> {
  let res = await fetch(url);
  // A 401 is an expired 15-minute access token, not an answer about entitlement,
  // so refresh and ask again. Without this a Pro tab left open past the token
  // lifetime revalidated on focus, read the 401 as 'free', and blurred the
  // summary the user had already paid for. Every other failure still falls
  // closed: a tier check that cannot reach the server must not grant Pro.
  if (res.status === 401 && (await attemptRefresh())) {
    res = await fetch(url);
  }
  if (!res.ok) return 'free';
  const json = await res.json();
  return json?.data?.tier ?? 'free';
}

export function useSubscription(opts: UseSubscriptionOptions = {}): UseSubscriptionResult {
  const { enabled = true, fallbackData } = opts;

  const { data, isLoading, mutate } = useSWR<SubscriptionTier>(
    enabled ? '/api/subscriptions' : null,
    fetchTier,
    {
      fallbackData,
      // focus revalidation handles Checkout/Portal return; reconnect adds noise on flaky connections
      revalidateOnReconnect: false,
    },
  );

  const tier = enabled ? (data ?? 'free') : fallbackData;

  return {
    tier,
    isPro: tier === 'pro',
    isLoading: enabled ? isLoading : false,
    mutate: async () => { await mutate(); },
  };
}
