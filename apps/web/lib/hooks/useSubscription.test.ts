import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';

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
