'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

// Side-effect-only component. Returns null. Fires a single POST when the
// dashboard mounts via a digest CTA (utm_source=digest + t=<token>), then
// strips the token from the URL so the recipient doesn't see it. SessionStorage
// dedupes per-token-per-session; cross-session duplicates are absorbed by the
// server's per-user-per-week aggregation.
const SS_PREFIX = 'digest_click_tracked_';

export function DigestClickTracker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The effect re-runs on every searchParams change, including the one our own
  // router.replace triggers below. The current early returns happen to short-
  // circuit the second pass (t is gone), but a per-mount guard makes that
  // safety explicit and survives future URL-shape changes.
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    if (searchParams.get('utm_source') !== 'digest') return;
    const token = searchParams.get('t');
    if (!token) return;

    const ssKey = SS_PREFIX + token;
    if (window.sessionStorage.getItem(ssKey)) {
      firedRef.current = true;
      return;
    }

    firedRef.current = true;
    let unmounted = false;

    // Set the dedupe flag BEFORE the network call resolves so a fast remount
    // (mobile/desktop flip, StrictMode dev double-mount) sees the flag and
    // skips. Trade-off: a network failure won't retry within the same session,
    // which is the right call here, this metric is lossy by nature (Apple MPP,
    // ad blockers, JS-disabled clients) and a duplicate write is more harmful
    // to the per-user-per-week dedupe SQL than a missed retry.
    window.sessionStorage.setItem(ssKey, '1');

    fetch('/api/track/digest/click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(() => {
        if (unmounted) return;

        // Strip the token from the visible URL. Preserve other params (datasetId,
        // utm_*) so existing dashboard behavior is undisturbed.
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
