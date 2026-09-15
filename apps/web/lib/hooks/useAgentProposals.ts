'use client';

import { useEffect, useRef, useState } from 'react';

import { useResource } from './useResource';
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
  const [resolveError, setResolveError] = useState<string | null>(null);

  const resolveControllers = useRef<Set<AbortController>>(new Set());
  const pendingIdsRef = useRef<Set<number>>(new Set());
  const enabledRef = useRef(enabled);
  const mountedRef = useRef(true);
  // Tracks the committed value, not the rendering one. React can start a
  // render and throw it away, and a ref written during that render keeps a
  // value the UI never showed, for good. The cost is a microtask-wide window
  // after a commit where a settling fetch still reads the previous value,
  // which is the lesser of the two: it resolves itself on the next tick.
  useEffect(() => {
    enabledRef.current = enabled;
  });

  const fetched = useResource(enabled ? 'agent-proposals' : null, async (signal) => {
    const res = await fetch('/api/proposals', { signal, credentials: 'same-origin' });
    if (SILENT_STATUSES.has(res.status)) return [];
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
    return (body.data as AgentProposalResponse[]) ?? [];
  });

  // Ids this session has resolved, hidden from the list rather than spliced out
  // of it. Filtering keeps the remaining rows in the order the server sent them,
  // which is why a rollback does not have to re-sort anything to put one back.
  // Tagged with the fetched array it was built against, so a reload starts clean.
  const [resolved, setResolved] = useState<{ base: AgentProposalResponse[] | null; ids: number[] }>({
    base: null,
    ids: [],
  });
  const hidden = resolved.base === fetched.data ? resolved.ids : [];
  const proposals = (fetched.data ?? []).filter((p) => !hidden.includes(p.id));
  const status: AgentProposalsStatus = fetched.status;
  const error = resolveError ?? fetched.error;

  const hide = (id: number) => setResolved({ base: fetched.data, ids: [...hidden, id] });
  const unhide = (id: number) => setResolved({ base: fetched.data, ids: hidden.filter((x) => x !== id) });

  // enabled flipping false has to stop the in-flight resolves too. The fetch
  // itself is already aborted by useResource's own cleanup.
  useEffect(() => {
    if (enabled) return;
    resolveControllers.current.forEach((controller) => controller.abort());
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

  // Not memoised. It only ever reaches click handlers, never a dependency array,
  // and the old useCallback listed [proposals] so it was rebuilt on nearly every
  // render anyway.
  async function resolveProposal(id: number, nextStatus: 'approved' | 'rejected') {
    // Dedup key is id alone: only one PATCH can ever resolve a proposal, so
    // a second call for this id is rejected outright, not collapsed by status.
    if (pendingIdsRef.current.has(id)) return false;

    hide(id);

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

      unhide(id);
      setResolveError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    } finally {
      resolveControllers.current.delete(controller);
      pendingIdsRef.current.delete(id);
    }
  }

  return { status, proposals, error, resolveProposal };
}
