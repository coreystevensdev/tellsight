'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface Props {
  token: string;
}

type Status = 'idle' | 'pending' | 'success' | 'error';

// The unmute action lives behind this button instead of firing on page
// render: Next.js prefetches viewport-visible <Link>s automatically, and a
// prefetch of a server component that mutates on render would silently
// undo the mute the moment the confirmation page loads.
export function UnmuteConfirmCard({ token }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const pendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const focusOnIdleRef = useRef(false);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (status === 'idle' && focusOnIdleRef.current) {
      confirmButtonRef.current?.focus();
      focusOnIdleRef.current = false;
    }
  }, [status]);

  async function confirmUnmute() {
    // status hasn't committed yet when a second click lands in the same
    // tick, so both handlers would read 'idle' off a state check; the ref
    // flips synchronously and actually closes the race.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setStatus('pending');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch(`/api/mute/alert-rule/${encodeURIComponent(token)}/unmute`, {
        method: 'POST',
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (controller.signal.aborted) return;
      if (res.ok) {
        setStatus('success');
        setMessage("You'll be notified again the next time this alert fires.");
      } else {
        setStatus('error');
        setMessage(body?.error?.message ?? 'This unmute link has expired or is invalid.');
      }
    } catch {
      if (controller.signal.aborted) return;
      setStatus('error');
      setMessage("We couldn't reach our server. Please try again in a few minutes.");
    } finally {
      pendingRef.current = false;
    }
  }

  function retry() {
    focusOnIdleRef.current = true;
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
          <Link href="/settings/alerts" className="text-muted-foreground hover:text-foreground">
            Manage alerts
          </Link>
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
        You&apos;ll start receiving this alert again once you confirm.
      </p>
      <button
        ref={confirmButtonRef}
        type="button"
        onClick={confirmUnmute}
        disabled={status === 'pending'}
        className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'pending' ? 'Unmuting…' : 'Confirm unmute'}
      </button>
    </>
  );
}
