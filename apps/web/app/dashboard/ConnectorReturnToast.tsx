'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

// Each connector's callback redirects here with its own query flag. Handling
// only `qb` meant Shopify and Square both landed on the dashboard silently:
// the connection had been stored and the first sync enqueued, and the screen
// said nothing at all.
const PROVIDERS = [
  { param: 'qb', label: 'QuickBooks' },
  { param: 'shopify', label: 'Shopify' },
  { param: 'square', label: 'Square' },
] as const;

export function ConnectorReturnToast() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;

    const hit = PROVIDERS.map((p) => ({ ...p, value: searchParams.get(p.param) })).find(
      (p) => p.value !== null,
    );
    if (!hit) return;

    firedRef.current = true;
    const { label, value } = hit;

    if (value === 'connected') {
      toast.success(`${label} connected`, {
        description: 'We’re syncing your transactions now, this can take a few minutes.',
      });
    } else if (value === 'denied') {
      toast.info(`${label} connection cancelled`, {
        description: `Nothing was saved. You can connect anytime from Settings > Integrations.`,
      });
    } else if (value === 'error') {
      toast.error(`${label} connection failed`, {
        description: `Something went wrong on the way back from ${label}. Retry from Settings > Integrations, we haven’t saved any of your data.`,
      });
    }

    router.replace('/dashboard', { scroll: false });
  }, [searchParams, router]);

  return null;
}
