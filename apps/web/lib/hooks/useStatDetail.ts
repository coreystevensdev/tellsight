'use client';

import { useEffect, useState } from 'react';
import type { StatDetailResponse } from 'shared/types';

export type StatDetailStatus = 'idle' | 'loading' | 'error' | 'done';

export interface UseStatDetailResult {
  status: StatDetailStatus;
  data: StatDetailResponse | null;
  error: string | null;
}

// Ids are colon-delimited and categories are free-form CSV text that can
// contain `/`, always encode the full id before it hits the URL, the server
// reads it back as one path segment.
export function useStatDetail(datasetId: number | null, statId: string | null): UseStatDetailResult {
  const [status, setStatus] = useState<StatDetailStatus>('idle');
  const [data, setData] = useState<StatDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${datasetId}:${statId}`;
  const [priorKey, setPriorKey] = useState(key);

  // The fetch effect below only notices an id change after paint -- without
  // this, switching directly from one resolved citation to another would
  // flash the previous citation's stale data for a frame.
  if (key !== priorKey) {
    setPriorKey(key);
    setStatus('idle');
    setData(null);
    setError(null);
  }

  useEffect(() => {
    if (datasetId === null || statId === null) return;

    const controller = new AbortController();
    // Kicking off the fetch, not resetting per-id state -- that's the
    // render-time check above. The abort on cleanup is what this effect
    // actually synchronizes with the outside world.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    setData(null);
    setError(null);

    fetch(`/api/ai-summaries/${datasetId}/stats/${encodeURIComponent(statId)}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        }
        setData(body.data as StatDetailResponse);
        setStatus('done');
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setStatus('error');
      });

    return () => controller.abort();
  }, [datasetId, statId]);

  return { status, data, error };
}
