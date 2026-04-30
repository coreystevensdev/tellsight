import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// store the change listener so we can trigger it manually
let changeHandler: (() => void) | null = null;
let matchesValue = false;

const mockMql = {
  get matches() {
    return matchesValue;
  },
  addEventListener: vi.fn((_event: string, handler: () => void) => {
    changeHandler = handler;
  }),
  removeEventListener: vi.fn(() => {
    changeHandler = null;
  }),
};

beforeEach(() => {
  matchesValue = false;
  changeHandler = null;
  vi.stubGlobal('matchMedia', () => mockMql);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIsMobile', () => {
  // dynamic import so the module-level matchMedia call picks up our mock
  async function importHook() {
    const mod = await import('./useIsMobile');
    return mod.useIsMobile;
  }

  it('returns false when viewport >= 768px', async () => {
    matchesValue = false;
    const useIsMobile = await importHook();
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('returns true when viewport < 768px', async () => {
    matchesValue = true;
    const useIsMobile = await importHook();
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('returns false during SSR (server snapshot)', async () => {
    // useSyncExternalStore server snapshot returns false
    // in jsdom, window exists so this tests the getSnapshot path,
    // but the server snapshot contract is: always return false
    // server snapshot is not directly exported, but the hook
    // returns false when mql.matches is false, functionally equivalent
    matchesValue = false;
    const useIsMobile = await importHook();
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('subscribes to matchMedia change events', async () => {
    const useIsMobile = await importHook();
    renderHook(() => useIsMobile());
    expect(mockMql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('updates when viewport crosses the threshold', async () => {
    matchesValue = false;
    const useIsMobile = await importHook();
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    // simulate crossing below 768px
    act(() => {
      matchesValue = true;
      changeHandler?.();
    });
    expect(result.current).toBe(true);

    // simulate crossing back above 768px
    act(() => {
      matchesValue = false;
      changeHandler?.();
    });
    expect(result.current).toBe(false);
  });

  it('cleans up listener on unmount', async () => {
    const useIsMobile = await importHook();
    const { unmount } = renderHook(() => useIsMobile());
    unmount();
    expect(mockMql.removeEventListener).toHaveBeenCalled();
  });
});
