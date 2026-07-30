'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

interface Props {
  token: string;
}

type Status = 'idle' | 'pending' | 'success' | 'error';

// The unsubscribe action lives behind this button instead of firing on page
// render: Next.js prefetches viewport-visible <Link>s automatically, and a
// prefetch of a server component that mutates on render would silently
// unsubscribe the user the moment the confirmation page loads.
export function DigestUnsubscribeConfirmCard({ token }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const pendingRef = useRef(false);

  async function confirmUnsubscribe() {
    // status hasn't committed yet when a second click lands in the same
    // tick, so both handlers would read 'idle' off a state check; the ref
    // flips synchronously and actually closes the race.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setStatus('pending');
    try {
      const res = await fetch(`/api/digest/unsubscribe/${encodeURIComponent(token)}`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setStatus('success');
        setMessage(
          "You won't receive any more weekly digest emails. You can re-enable them anytime from your settings.",
        );
      } else {
        setStatus('error');
        setMessage(body?.error?.message ?? 'This unsubscribe link has expired or is invalid.');
      }
    } catch {
      setStatus('error');
      setMessage("We couldn't reach our server. Please try again in a few minutes.");
    } finally {
      pendingRef.current = false;
    }
  }

  function retry() {
    setStatus('idle');
    setMessage('');
  }

  if (status === 'success' || status === 'error') {
    return (
      <>
        <p aria-live="polite" className="text-sm leading-relaxed text-muted-foreground">
          {message}
        </p>
        <div className="mt-8 flex items-center gap-4 text-sm">
          <Link href="/" className="text-primary hover:underline">
            Back to Tellsight
          </Link>
          {status === 'success' && (
            <Link
              href="/settings/email"
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
            >
              Resubscribe
            </Link>
          )}
          {status === 'error' && (
            <Link href="/settings/email" className="text-muted-foreground hover:text-foreground">
              Manage preferences
            </Link>
          )}
          {status === 'error' && (
            <button type="button" onClick={retry} className="text-primary hover:underline">
              Try again
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <p aria-live="polite" className="text-sm leading-relaxed text-muted-foreground">
        You&apos;ll stop receiving weekly digest emails once you confirm.
      </p>
      <button
        type="button"
        onClick={confirmUnsubscribe}
        disabled={status === 'pending'}
        className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'pending' ? 'Unsubscribing…' : 'Confirm unsubscribe'}
      </button>
    </>
  );
}
