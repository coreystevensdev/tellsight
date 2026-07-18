'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

// Side-effect-only component. Returns null. Fires a single POST when the
// dashboard mounts via an alert CTA (utm_source=alert + t=<token>), then
// strips the token from the URL so the recipient doesn't see it. Mirrors
// DigestClickTracker's dedupe/strip behavior; see that file for the
// reasoning behind the sessionStorage-before-fetch ordering.
const SS_PREFIX = 'alert_click_tracked_';

export function AlertClickTracker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    if (searchParams.get('utm_source') !== 'alert') return;
    const token = searchParams.get('t');
    if (!token) return;

    const ssKey = SS_PREFIX + token;
    if (window.sessionStorage.getItem(ssKey)) {
      firedRef.current = true;
      return;
    }

    firedRef.current = true;
    let unmounted = false;

    window.sessionStorage.setItem(ssKey, '1');

    fetch('/api/track/alert/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(() => {
        if (unmounted) return;

        const next = new URLSearchParams(searchParams.toString());
        next.delete('t');
        const qs = next.toString();
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      })
      .catch(() => {
        // Non-critical; the metric absorbs the loss.
      });

    return () => {
      unmounted = true;
    };
  }, [router, pathname, searchParams]);

  return null;
}
