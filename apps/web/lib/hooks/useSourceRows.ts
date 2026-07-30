'use client';

import { useEffect, useState } from 'react';
import type { SourceRow } from 'shared/types';

// Dates cross the wire as ISO strings, not Date instances, mirroring how
// AnalyticsEventRow types createdAt as string despite the DB column being a
// real date.
export type SourceRowView = Omit<SourceRow, 'date'> & { date: string };

export interface SourceRowsMeta {
  total: number;
  pagination: { page: number; pageSize: number; totalPages: number };
}

export type SourceRowsStatus = 'idle' | 'loading' | 'error' | 'done';

export interface UseSourceRowsResult {
  status: SourceRowsStatus;
  rows: SourceRowView[];
  meta: SourceRowsMeta | null;
  error: string | null;
}

export const SOURCE_ROWS_PAGE_SIZE = 25;

// Mirrors useStatDetail's fetch/abort/cancel shape. `page` is in the effect
// dependency array so paging forward cancels whatever the previous page's
// request was still doing.
export function useSourceRows(
  datasetId: number | null,
  statId: string | null,
  page: number,
): UseSourceRowsResult {
  const [status, setStatus] = useState<SourceRowsStatus>('idle');
  const [rows, setRows] = useState<SourceRowView[]>([]);
  const [meta, setMeta] = useState<SourceRowsMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${datasetId}:${statId}`;
  const [priorKey, setPriorKey] = useState(key);

  // The fetch effect below only notices an id change after paint -- without
  // this, switching directly from one resolved citation to another would
  // flash the previous citation's stale rows for a frame.
  if (key !== priorKey) {
    setPriorKey(key);
    setStatus('idle');
    setRows([]);
    setMeta(null);
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
    setError(null);

    const offset = (page - 1) * SOURCE_ROWS_PAGE_SIZE;
    const params = new URLSearchParams({ limit: String(SOURCE_ROWS_PAGE_SIZE), offset: String(offset) });

    fetch(`/api/ai-summaries/${datasetId}/stats/${encodeURIComponent(statId)}/rows?${params}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        }
        setRows(body.data as SourceRowView[]);
        setMeta(body.meta as SourceRowsMeta);
        setStatus('done');
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setStatus('error');
      });

    return () => controller.abort();
  }, [datasetId, statId, page]);

  return { status, rows, meta, error };
}
