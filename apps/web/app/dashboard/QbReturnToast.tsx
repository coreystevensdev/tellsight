'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';

export function QbReturnToast() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    const qb = searchParams.get('qb');
    if (!qb) return;

    firedRef.current = true;
    if (qb === 'connected') {
      toast.success('QuickBooks connected', {
        description: 'We\u2019re syncing your transactions now, this can take a few minutes.',
      });
    } else if (qb === 'denied') {
      toast.info('QuickBooks connection cancelled', {
        description: 'Nothing was saved. You can connect anytime from Settings > Integrations.',
      });
    } else if (qb === 'error') {
      toast.error('QuickBooks connection failed', {
        description: 'Something went wrong on the way back from QuickBooks. Retry from Settings > Integrations, we haven\u2019t saved any of your data.',
      });
    }

    router.replace('/dashboard', { scroll: false });
  }, [searchParams, router]);

  return null;
}
