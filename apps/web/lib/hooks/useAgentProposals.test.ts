import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAgentProposals } from './useAgentProposals';

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
});
