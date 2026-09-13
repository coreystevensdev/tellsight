import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';

import { attemptRefresh } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  attemptRefresh: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// fresh SWR cache per test, prevents deduplication across tests
function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children,
  );
}

// dynamic imports per test avoid Vitest module caching, each test gets a fresh hook instance
describe('useSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  // fetchTier's !res.ok branch had no coverage, so changing its 'free' to 'pro'
  // would have passed every test here while granting Pro to everyone the moment
  // /api/subscriptions returned a 500. An entitlement check has to fail closed.
  // 401 is deliberately absent, it is a stale credential rather than an answer,
  // and the two cases below cover it.
  it.each([500, 502, 403])('falls back to free when the API returns %i', async (status) => {
    mockFetch.mockReturnValue(jsonResponse({ error: 'nope' }, status));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
    expect(attemptRefresh).not.toHaveBeenCalled();
  });

  // Found in production 2026-09-13: a Pro tab left open past the 15-minute access
  // token revalidated on focus, got a 401, and read it as a downgrade. The card
  // then blurred a summary that had already been generated and paid for, and the
  // pro-to-free watcher in DashboardShell announced the subscription had ended.
  it('refreshes and re-asks when the tier call returns 401', async () => {
    vi.mocked(attemptRefresh).mockResolvedValueOnce(true);
    mockFetch
      .mockReturnValueOnce(jsonResponse({ error: 'expired' }, 401))
      .mockReturnValueOnce(jsonResponse({ data: { tier: 'pro' } }));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.tier).toBe('pro'));

    expect(result.current.isPro).toBe(true);
    expect(attemptRefresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // A refresh token that is itself dead is a real end of session, so this one
  // still falls closed, and without a second request.
  it('falls back to free when the refresh after a 401 fails', async () => {
    vi.mocked(attemptRefresh).mockResolvedValueOnce(false);
    mockFetch.mockReturnValue(jsonResponse({ error: 'expired' }, 401));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // Same branch from the other side: a 200 whose body is not the shape we expect
  // must not read as Pro either.
  it('falls back to free when the response body has no tier', async () => {
    mockFetch.mockReturnValue(jsonResponse({ data: {} }));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
  });

  it('returns free tier when no subscription exists', async () => {
    mockFetch.mockReturnValue(jsonResponse({ data: { tier: 'free' } }));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
  });

  it('returns pro tier for active subscription', async () => {
    mockFetch.mockReturnValue(jsonResponse({ data: { tier: 'pro' } }));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tier).toBe('pro');
    expect(result.current.isPro).toBe(true);
  });

  it('skips fetch when enabled is false', async () => {
    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: false }), { wrapper });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.tier).toBeUndefined();
    expect(result.current.isPro).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('defaults to free while loading', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    expect(result.current.tier).toBe('free');
    expect(result.current.isPro).toBe(false);
  });

  it('uses fallbackData when provided', async () => {
    // fetch never resolves, fallbackData should surface immediately
    mockFetch.mockReturnValue(new Promise(() => {}));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(
      () => useSubscription({ enabled: true, fallbackData: 'pro' }),
      { wrapper },
    );

    // tier comes from fallbackData before fetch completes
    expect(result.current.tier).toBe('pro');
    expect(result.current.isPro).toBe(true);
  });

  it('exposes mutate for manual revalidation', async () => {
    mockFetch.mockReturnValue(jsonResponse({ data: { tier: 'free' } }));

    const { useSubscription } = await import('./useSubscription.js');
    const { result } = renderHook(() => useSubscription({ enabled: true }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(typeof result.current.mutate).toBe('function');
  });
});
