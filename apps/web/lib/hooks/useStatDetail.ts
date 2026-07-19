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

  useEffect(() => {
    if (datasetId === null || statId === null) {
      setStatus('idle');
      setData(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
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
