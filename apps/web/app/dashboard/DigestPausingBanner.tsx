'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { CalendarClock, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DigestPausingBannerProps {
  /** ISO timestamp the API computed from the active dataset and the freshness window. */
  digestPausesAt: string | null | undefined;
  now?: Date;
  className?: string;
}

// Shown only in the last stretch before the digest stops. Earlier than this it
// is noise: the user has weeks, and a banner they scroll past for a month is a
// banner they will not read on the day it matters.
const WARN_WITHIN_DAYS = 7;

const DISMISS_KEY = 'digestPausingBanner:dismissed';

// Same shape as CashBalanceStaleBanner's store, and for the same reason:
// sessionStorage emits no event for a same-document write, and getServerSnapshot
// has to answer without touching storage at all or the server's markup and the
// browser's first render disagree. Every access is guarded, since storage throws
// outright in some privacy modes.
const dismissListeners = new Set<() => void>();

function subscribeDismissed(onChange: () => void) {
  dismissListeners.add(onChange);
  return () => dismissListeners.delete(onChange);
}

function readDismissed() {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissBanner() {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Nothing to persist, but it still closes for this render pass.
  }
  dismissListeners.forEach((notify) => notify());
}

export function daysUntil(pausesAt: Date, now: Date): number {
  return Math.ceil((pausesAt.getTime() - now.getTime()) / 86_400_000);
}

export function DigestPausingBanner({ digestPausesAt, now = new Date(), className }: DigestPausingBannerProps) {
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => false);

  if (!digestPausesAt || dismissed) return null;

  const pausesAt = new Date(digestPausesAt);
  if (Number.isNaN(pausesAt.getTime())) return null;

  const days = daysUntil(pausesAt, now);
  // Already paused is not this banner's job. Once it has stopped, "in 0 days"
  // is wrong and the message needs to be about restarting it, not preventing it.
  if (days > WARN_WITHIN_DAYS || days <= 0) return null;

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30',
        className,
      )}
    >
      <CalendarClock className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
      <div className="min-w-[14rem] flex-1">
        <p className="text-sm font-medium text-foreground">
          {days === 1 ? 'Your weekly digest pauses tomorrow' : `Your weekly digest pauses in ${days} days`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          It stops when nothing new has arrived for a while, because a digest over unchanged data
          just repeats last week. Upload to keep it coming.
        </p>
        <Link
          href="/upload"
          className="mt-2 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Upload a CSV
        </Link>
      </div>
      <button
        onClick={dismissBanner}
        className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Dismiss banner"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
