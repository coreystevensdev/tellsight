'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';

interface Props {
  token: string;
}

type Status = 'idle' | 'pending' | 'success' | 'error';

interface MuteData {
  muteUntil: string;
  ruleKindLabel: string;
  orgName: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'a later date';
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

// The mute action lives behind this button instead of firing on page
// render: Next.js prefetches viewport-visible <Link>s automatically, and a
// prefetch of a server component that mutates on render would silently
// mute the rule the moment the confirmation page loads.
export function MuteConfirmCard({ token }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [unmuteHref, setUnmuteHref] = useState('');
  const pendingRef = useRef(false);

  async function confirmMute() {
    // status hasn't committed yet when a second click lands in the same
    // tick, so both handlers would read 'idle' off a state check; the ref
    // flips synchronously and actually closes the race.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setStatus('pending');
    try {
      const res = await fetch(`/api/mute/alert-rule/${encodeURIComponent(token)}`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.data) {
        const { muteUntil, ruleKindLabel, orgName } = body.data as MuteData;
        setStatus('success');
        setMessage(`You won't hear about ${ruleKindLabel} for ${orgName} until ${formatDate(muteUntil)}.`);
        setUnmuteHref(`/mute/alert-rule/${encodeURIComponent(token)}/unmute`);
      } else {
        setStatus('error');
        setMessage(body?.error?.message ?? 'This mute link has expired or is invalid.');
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
          {status === 'success' && unmuteHref && (
            <Link
              href={unmuteHref}
              className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground hover:bg-primary/90"
            >
              Unmute
            </Link>
          )}
          {status === 'error' && (
            <Link href="/settings/alerts" className="text-muted-foreground hover:text-foreground">
              Manage alerts
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
        You&apos;ll stop hearing about this alert once you confirm.
      </p>
      <button
        type="button"
        onClick={confirmMute}
        disabled={status === 'pending'}
        className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === 'pending' ? 'Muting…' : 'Confirm mute'}
      </button>
    </>
  );
}
