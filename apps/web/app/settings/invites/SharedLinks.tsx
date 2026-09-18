'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { useResource } from '@/lib/hooks/useResource';

interface Share {
  id: number;
  datasetId: number;
  expiresAt: string | null;
  viewCount: number;
  isMine: boolean;
}

function daysUntil(iso: string, from: number) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - from) / (1000 * 60 * 60 * 24)));
}

export default function SharedLinks() {
  const [revoking, setRevoking] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useResource('org-shares', async (signal) => {
    const { data } = await apiClient<Share[]>('/shares', { signal });
    return { rows: data, loadedAt: Date.now() };
  });

  const shares = list.data?.rows ?? [];
  const loadedAt = list.data?.loadedAt ?? 0;

  async function revoke(id: number) {
    setRevoking(id);
    setError(null);

    try {
      await apiClient(`/shares/${id}`, { method: 'DELETE' });
      list.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke that link');
    } finally {
      setRevoking(null);
    }
  }

  if (list.status === 'loading' || list.status === 'error') return null;
  if (shares.length === 0) return null;

  return (
    <section>
      <h2 className="font-serif text-lg font-medium text-foreground">Shared links</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Anyone with one of these can read the summary it was made from, without signing in. Revoking
        breaks the link straight away.
      </p>

      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {shares.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <span className="text-xs text-muted-foreground">
              Link #<span className="font-mono">{s.id}</span> on dataset{' '}
              <span className="font-mono">{s.datasetId}</span>
              {!s.isMine && <span className="ml-2">shared by someone else</span>}
            </span>

            <span className="flex items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">
                {s.viewCount} view{s.viewCount === 1 ? '' : 's'}
                {s.expiresAt && `, ${daysUntil(s.expiresAt, loadedAt)}d left`}
              </span>
              <button
                type="button"
                onClick={() => revoke(s.id)}
                disabled={revoking === s.id}
                aria-label={`Revoke shared link ${s.id}`}
                className="min-h-11 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-destructive hover:text-destructive disabled:opacity-50"
              >
                {revoking === s.id ? 'Revoking...' : 'Revoke'}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
