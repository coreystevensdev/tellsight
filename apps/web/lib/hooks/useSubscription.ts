import useSWR from 'swr';
import type { SubscriptionTier } from 'shared/types';

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
  const res = await fetch(url);
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
