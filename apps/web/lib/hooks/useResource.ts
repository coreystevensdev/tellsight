'use client';

import { useEffect, useRef, useState } from 'react';

export type ResourceStatus = 'idle' | 'loading' | 'error' | 'done';

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: string | null;
  refetch: () => void;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: string | null;
}

// Holds one settled result, tagged with the key it answers, and works out the
// status by comparing that tag against the key being asked about right now.
//
// That comparison is the whole point. Every hand-rolled version of this in the
// app opened its effect with setStatus('loading'), which costs a render pass
// before paint and is what react-hooks/set-state-in-effect objects to. Here
// there is no loading to announce: not holding an answer for the current key
// already means loading, so the effect only ever writes a result.
//
// It also closes a bug the separate-flags version kept reintroducing. With
// status and data in different useStates, the frame after the key changes
// still holds the previous key's data, so switching from one resource to
// another flashes the old one. A result that does not match the current key is
// simply not returned.
export function useResource<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Synced after commit, never during render: React can abandon a render, and
  // a ref written during one it throws away keeps a loader the UI never used.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  useEffect(() => {
    if (key === null) return;

    const controller = new AbortController();
    let cancelled = false;

    loadRef
      .current(controller.signal)
      .then((data) => {
        if (!cancelled) setSettled({ key, data, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // An abort is this hook's own cleanup firing, not a failure to report.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setSettled({ key, data: null, error: err instanceof Error ? err.message : 'Something went wrong' });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, attempt]);

  const refetch = () => setAttempt((n) => n + 1);

  if (key === null) return { status: 'idle', data: null, error: null, refetch };
  if (settled?.key !== key) return { status: 'loading', data: null, error: null, refetch };
  if (settled.error !== null) return { status: 'error', data: null, error: settled.error, refetch };
  return { status: 'done', data: settled.data, error: null, refetch };
}
