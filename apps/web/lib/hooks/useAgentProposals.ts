'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentProposalResponse } from 'shared/agent';

export type AgentProposalsStatus = 'idle' | 'loading' | 'error' | 'done';

export interface UseAgentProposalsResult {
  status: AgentProposalsStatus;
  proposals: AgentProposalResponse[];
  error: string | null;
  resolveProposal: (id: number, status: 'approved' | 'rejected') => Promise<boolean>;
}

// 401 (logged out, dashboard is public) and 403 (org isn't on the Agent
// tier) both mean "nothing to show", not a fetch failure -- every free/demo
// visitor would otherwise see an error the drawer has no business surfacing.
const SILENT_STATUSES = new Set([401, 403]);

// enabled is false for logged-out dashboard visits, skipping the request
// entirely rather than firing it and discarding a guaranteed 401.
export function useAgentProposals(enabled: boolean): UseAgentProposalsResult {
  const [status, setStatus] = useState<AgentProposalsStatus>('idle');
  const [proposals, setProposals] = useState<AgentProposalResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  const resolveControllers = useRef<Set<AbortController>>(new Set());
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  // Synced during render, not inside the effect below -- a passive effect
  // runs after commit, leaving a window where a settling fetch could still
  // read a stale value.
  enabledRef.current = enabled;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      setProposals([]);
      setError(null);
      resolveControllers.current.forEach((controller) => controller.abort());
      return;
    }

    const controller = new AbortController();
    setStatus('loading');
    setError(null);

    fetch('/api/proposals', { signal: controller.signal, credentials: 'same-origin' })
      .then(async (res) => {
        if (SILENT_STATUSES.has(res.status)) {
          setProposals([]);
          setStatus('done');
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
        setProposals((body.data as AgentProposalResponse[]) ?? []);
        setStatus('done');
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setStatus('error');
      });

    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    // StrictMode double-invokes this effect on initial mount (setup, cleanup,
    // setup) without unmounting for real -- reset here so the simulated cycle
    // doesn't leave mountedRef stuck false for the component's actual life.
    mountedRef.current = true;
    // Same Set instance for the component's whole life (useRef(new Set())
    // never replaces it, only mutates it) -- capturing it here satisfies
    // exhaustive-deps without changing which controllers get aborted.
    const controllers = resolveControllers.current;
    return () => {
      mountedRef.current = false;
      controllers.forEach((controller) => controller.abort());
    };
  }, []);

  const resolveProposal = useCallback(async (id: number, nextStatus: 'approved' | 'rejected') => {
    // Dedup key is id alone: only one PATCH can ever resolve a proposal, so
    // a second call for this id is rejected outright, not collapsed by status.
    if (pendingIdsRef.current.has(id)) return false;

    const removed = proposals.find((p) => p.id === id);
    setProposals((cur) => cur.filter((p) => p.id !== id));

    const controller = new AbortController();
    resolveControllers.current.add(controller);

    try {
      pendingIdsRef.current.add(id);
      const res = await fetch(`/api/proposals/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status: nextStatus }),
        signal: controller.signal,
      });

      // A response can arrive after enabled has already flipped false, or
      // after true unmount with enabled never flipping -- abort() can't
      // un-deliver it, so this backstop silences it directly either way.
      if (!enabledRef.current || !mountedRef.current) return false;

      if (res.status === 404) {
        // Already resolved by someone else -- the row is gone from the
        // drawer either way, so this isn't a user-facing error.
        console.warn('[useAgentProposals] proposal already resolved', { id, nextStatus });
        return true;
      }
      if (res.ok) return true;

      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      if (!enabledRef.current || !mountedRef.current) return false;

      if (removed) {
        setProposals((cur) => [...cur, removed].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
      }
      setError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      resolveControllers.current.delete(controller);
      pendingIdsRef.current.delete(id);
    }
  }, [proposals]);

  return { status, proposals, error, resolveProposal };
}
