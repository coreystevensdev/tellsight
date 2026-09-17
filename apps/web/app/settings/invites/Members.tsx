'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { useResource } from '@/lib/hooks/useResource';

interface Member {
  isSelf: boolean;
  userId: number;
  role: 'owner' | 'member';
  name: string;
  email: string;
}

export default function Members() {
  const [confirming, setConfirming] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useResource('org-members', async (signal) => {
    const { data } = await apiClient<Member[]>('/org/members', { signal });
    return data;
  });

  const members = list.data ?? [];

  async function remove(userId: number) {
    setRemoving(userId);
    setError(null);

    try {
      await apiClient(`/org/members/${userId}`, { method: 'DELETE' });
      setConfirming(null);
      list.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove them');
    } finally {
      setRemoving(null);
    }
  }

  // A non-owner never reaches this page, but if the request fails the page still
  // has its invite half to show, so this renders nothing rather than an error.
  if (list.status === 'loading') return <p className="text-sm text-muted-foreground">Loading the team...</p>;
  if (list.status === 'error') return null;

  return (
    <section>
      <h2 className="font-serif text-lg font-medium text-foreground">Who is in this organization</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Removing someone ends their access right away. Their account and anything they uploaded stay.
      </p>

      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">
                {m.name}
                {m.isSelf && <span className="ml-2 text-xs text-muted-foreground">you</span>}
              </p>
              <p className="truncate text-xs text-muted-foreground">{m.email}</p>
            </div>

            <span className="text-xs uppercase tracking-wide text-muted-foreground">{m.role}</span>

            {!m.isSelf && (
              confirming === m.userId ? (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => remove(m.userId)}
                    disabled={removing === m.userId}
                    className="min-h-11 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground disabled:opacity-50"
                  >
                    {removing === m.userId ? 'Removing...' : `Remove ${m.name}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="min-h-11 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(m.userId)}
                  aria-label={`Remove ${m.name} from this organization`}
                  className="min-h-11 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-destructive hover:text-destructive"
                >
                  Remove
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
