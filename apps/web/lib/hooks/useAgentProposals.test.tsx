import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, render, waitFor, act } from '@testing-library/react';
import { useAgentProposals, type UseAgentProposalsResult } from './useAgentProposals';

function ProposalsHarness({ onReady }: { onReady: (result: UseAgentProposalsResult) => void }) {
  const result = useAgentProposals(true);
  onReady(result);
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const proposalA = {
  id: 10,
  orgId: 1,
  kind: 'trend',
  severity: 'warning',
  title: 'Marketing spend up 30%',
  explanation: 'Ad spend rose sharply against the prior month.',
  recommendation: 'Review the largest campaigns.',
  confidence: '0.82',
  evidence: ['monthly_marketing_spend'],
  action: null,
  dedupKey: 'trend:marketing_spend:default',
  lane: 'needs_approval',
  period: '2026-07',
  status: 'pending' as const,
  createdAt: '2026-07-20T00:00:00.000Z',
  expiresAt: '2026-08-03T00:00:00.000Z',
  resolvedAt: null,
  resolvedByUserId: null,
};

describe('useAgentProposals', () => {
  it('does not fetch when disabled', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useAgentProposals(false));

    expect(result.current.status).toBe('idle');
    expect(result.current.proposals).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches pending proposals on mount when enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.proposals).toEqual([proposalA]);
  });

  it('treats 403 (no Agent tier entitlement) as an empty list, not an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { code: 'AGENT_TIER_REQUIRED' } }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.proposals).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('treats 401 (logged out) as an empty list, not an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { code: 'UNAUTHENTICATED' } }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));

    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.proposals).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('transitions to error on an unexpected server failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Something broke' } }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Something broke');
  });

  it('resolveProposal removes the row optimistically and keeps it removed on success', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let ok = false;
    await act(async () => {
      ok = await result.current.resolveProposal(10, 'approved');
    });

    expect(ok).toBe(true);
    expect(result.current.proposals).toEqual([]);
  });

  it('resolveProposal treats a 404 (already resolved) as success and keeps the row removed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({ error: { message: 'Not found' } }) } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let ok = false;
    await act(async () => {
      ok = await result.current.resolveProposal(10, 'approved');
    });

    expect(ok).toBe(true);
    expect(result.current.proposals).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[useAgentProposals] proposal already resolved', { id: 10, nextStatus: 'approved' });
  });

  it('resolveProposal restores the row and sets an error on a genuine failure', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { message: 'Update failed' } }),
      } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let ok = true;
    await act(async () => {
      ok = await result.current.resolveProposal(10, 'rejected');
    });

    expect(ok).toBe(false);
    expect(result.current.proposals).toEqual([proposalA]);
    expect(result.current.error).toBe('Update failed');
  });

  it('resolveProposal sends the status in the PATCH body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    await act(async () => {
      await result.current.resolveProposal(10, 'rejected');
    });

    expect(fetchSpy).toHaveBeenLastCalledWith('/api/proposals/10', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected' }),
    }));
  });

  it('sends an AbortController signal on the PATCH request', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    await act(async () => {
      await result.current.resolveProposal(10, 'approved');
    });

    expect(fetchSpy).toHaveBeenLastCalledWith('/api/proposals/10', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('aborts an in-flight resolveProposal PATCH on unmount without a post-unmount state update', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, unmount } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    // Mirrors real fetch's AbortController integration: the pending request
    // rejects once its signal fires, instead of resolving or hanging forever.
    let patchSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      patchSignal = (init as RequestInit).signal ?? undefined;
      return new Promise((_resolve, reject) => {
        patchSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'approved');
    });

    expect(() => unmount()).not.toThrow();
    expect(patchSignal?.aborted).toBe(true);

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });
  });

  it('silences a resolveProposal PATCH response that arrives after true unmount, with enabled never flipping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, unmount } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let resolvePatch!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'approved');
    });

    expect(() => unmount()).not.toThrow();

    // The fetch settles on its own, independent of the abort signal fired by
    // unmount -- mirrors a response that was already in flight over the wire.
    resolvePatch({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });
  });

  it('silences a genuine (non-abort) fetch rejection that arrives after true unmount, with enabled never flipping', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, unmount } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let rejectPatch!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPatch = reject; }));

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'rejected');
    });

    expect(() => unmount()).not.toThrow();

    rejectPatch(new TypeError('Failed to fetch'));

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });
  });

  it('resets mountedRef on StrictMode\'s dev-only double-invoke, so error handling still works after the simulated remount', async () => {
    // StrictMode double-invokes the data-fetch effect on initial mount
    // (setup, cleanup, setup again), firing the GET twice before settling.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: [proposalA] }) } as Response);

    let latest: UseAgentProposalsResult | undefined;
    render(
      <StrictMode>
        <ProposalsHarness onReady={(result) => { latest = result; }} />
      </StrictMode>,
    );

    await waitFor(() => expect(latest?.status).toBe('done'));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Update failed' } }),
    } as Response);

    let ok = true;
    await act(async () => {
      ok = await latest!.resolveProposal(10, 'rejected');
    });

    // A stuck-false mountedRef would silence this failure via the backstop
    // check instead of surfacing it -- both paths return `false` here, so the
    // discriminator is whether the error actually made it through.
    expect(ok).toBe(false);
    expect(latest!.error).toBe('Update failed');
  });

  it('dedupes a second resolveProposal call for the same id while the first PATCH is in flight', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let resolvePatch!: (value: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));

    let firstResult!: Promise<boolean>;
    let secondResult!: Promise<boolean>;
    act(() => {
      firstResult = result.current.resolveProposal(10, 'approved');
      secondResult = result.current.resolveProposal(10, 'approved');
    });

    await expect(secondResult).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial GET + one PATCH, no second PATCH

    resolvePatch({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);
    await act(async () => {
      await expect(firstResult).resolves.toBe(true);
    });
  });

  it('dedupes by id alone, so an approve then a reject on the same id is also rejected outright', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    let resolvePatch!: (value: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));

    let firstResult!: Promise<boolean>;
    let secondResult!: Promise<boolean>;
    act(() => {
      firstResult = result.current.resolveProposal(10, 'approved');
      secondResult = result.current.resolveProposal(10, 'rejected');
    });

    await expect(secondResult).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    resolvePatch({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response);
    await act(async () => {
      await expect(firstResult).resolves.toBe(true);
    });
  });

  it('aborts an in-flight resolveProposal PATCH when enabled flips false, with no state update after', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, rerender } = renderHook(({ enabled }) => useAgentProposals(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    let patchSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => {
      patchSignal = (init as RequestInit).signal ?? undefined;
      return new Promise((_resolve, reject) => {
        patchSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'approved');
    });

    act(() => {
      rerender({ enabled: false });
    });

    expect(patchSignal?.aborted).toBe(true);

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });

    expect(result.current.error).toBeNull();
  });

  it('silences a stale non-2xx PATCH response that resolves after enabled has already flipped false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, rerender } = renderHook(({ enabled }) => useAgentProposals(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    let resolvePatch!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((resolve) => { resolvePatch = resolve; }));

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'rejected');
    });

    act(() => {
      rerender({ enabled: false });
    });

    // Response arrives after the disable effect has already committed --
    // enabledRef.current is false by the time resolveProposal reads it.
    resolvePatch({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { message: 'Update failed' } }),
    } as Response);

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });

    expect(result.current.error).toBeNull();
    expect(result.current.proposals).toEqual([]);
  });

  it('transiently rejects a same-id call submitted mid-abort, then lets a later call through once cleanup settles', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, rerender } = renderHook(({ enabled }) => useAgentProposals(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    let patchSignal: AbortSignal | undefined;
    fetchSpy.mockImplementationOnce((_url, init) => {
      patchSignal = (init as RequestInit).signal ?? undefined;
      return new Promise((_resolve, reject) => {
        patchSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    let firstResult!: Promise<boolean>;
    act(() => {
      firstResult = result.current.resolveProposal(10, 'approved');
    });

    act(() => {
      rerender({ enabled: false });
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2); // initial GET + the first PATCH, aborted but not yet settled

    // The abort has fired but the first call's own catch/finally hasn't run
    // yet (that's a pending microtask). A same-id call submitted right now
    // must not be admitted -- pendingIdsRef still owns id 10 until the first
    // call's finally releases it. The earlier, twice-reverted clear()-based
    // fix would have wrongly let this through and fired a second PATCH.
    let midAbortResult!: Promise<boolean>;
    act(() => {
      midAbortResult = result.current.resolveProposal(10, 'approved');
    });

    await expect(midAbortResult).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // still no third fetch call

    await act(async () => {
      await expect(firstResult).resolves.toBe(false);
    });

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    act(() => {
      rerender({ enabled: true });
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    expect(fetchSpy).toHaveBeenCalledTimes(3); // re-enable GET

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: 10 } }),
    } as Response);

    await act(async () => {
      await expect(result.current.resolveProposal(10, 'approved')).resolves.toBe(true);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy).toHaveBeenLastCalledWith('/api/proposals/10', expect.objectContaining({
      body: JSON.stringify({ status: 'approved' }),
    }));
  });

  it('silences a genuine (non-abort) fetch rejection that arrives after enabled has already flipped false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA] }),
    } as Response);

    const { result, rerender } = renderHook(({ enabled }) => useAgentProposals(enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.status).toBe('done'));

    let rejectPatch!: (reason: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPatch = reject; }));

    let resolvePromise!: Promise<boolean>;
    act(() => {
      resolvePromise = result.current.resolveProposal(10, 'rejected');
    });

    act(() => {
      rerender({ enabled: false });
    });

    // A genuine network failure, not the AbortError from cancellation --
    // exercises the enabledRef backstop inside the catch block specifically.
    rejectPatch(new TypeError('Failed to fetch'));

    await act(async () => {
      await expect(resolvePromise).resolves.toBe(false);
    });

    expect(result.current.error).toBeNull();
  });

  it('resolves two different ids concurrently without either blocking the other', async () => {
    const proposalB = { ...proposalA, id: 11 };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [proposalA, proposalB] }),
    } as Response);

    const { result } = renderHook(() => useAgentProposals(true));
    await waitFor(() => expect(result.current.status).toBe('done'));

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 10 } }) } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ data: { id: 11 } }) } as Response);

    await act(async () => {
      const resultA = result.current.resolveProposal(10, 'approved');
      const resultB = result.current.resolveProposal(11, 'approved');
      await expect(resultA).resolves.toBe(true);
      await expect(resultB).resolves.toBe(true);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3); // initial GET + one PATCH per id
  });
});
