'use client';

import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';

// Low-visibility metadata next to the AI summary card. Render nothing for the
// anonymous + never-digested cases (silence is the correct UX); the indicator
// is non-critical and never blocks the card render.
//
// SWR (vs raw fetch) gives us per-session dedupe, no double-fire when this
// component remounts on mobile/desktop layout flips, and a focus-revalidation
// path so "Last digest sent just now" flips moments after a send.
const SWR_KEY = '/api/digest/last-sent';

interface LastSentResponse {
  data?: { lastSentAt: string | null };
}

async function fetchLastSent(key: string): Promise<string | null> {
  const res = await fetch(key);
  if (!res.ok) return null;
  const json = (await res.json()) as LastSentResponse;
  return json.data?.lastSentAt ?? null;
}

export function LastDigestIndicator() {
  const { data: lastSentAt } = useSWR<string | null>(SWR_KEY, fetchLastSent, {
    revalidateOnFocus: true,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });

  if (typeof lastSentAt !== 'string') return null;
  const parsed = new Date(lastSentAt);
  if (Number.isNaN(parsed.getTime())) return null;

  return (
    <p className="text-xs text-muted-foreground" data-testid="last-digest-indicator">
      Last digest sent {formatDistanceToNow(parsed, { addSuffix: true })}
    </p>
  );
}
