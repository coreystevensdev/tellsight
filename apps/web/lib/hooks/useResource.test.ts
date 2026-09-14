import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useResource } from './useResource';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useResource', () => {
  it('stays idle and never calls the loader while the key is null', () => {
    const load = vi.fn().mockResolvedValue('x');
    const { result } = renderHook(() => useResource(null, load));

    expect(result.current.status).toBe('idle');
    expect(load).not.toHaveBeenCalled();
  });

  it('reads as loading until the loader settles', async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useResource('a', () => d.promise));

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();

    await act(async () => {
      d.resolve('hello');
    });

    expect(result.current.status).toBe('done');
    expect(result.current.data).toBe('hello');
  });

  it('reports the loader failure message', async () => {
    const { result } = renderHook(() => useResource('a', () => Promise.reject(new Error('nope'))));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('nope');
    expect(result.current.data).toBeNull();
  });

  // The reason this hook holds one keyed result instead of separate status and
  // data flags. With separate flags the frame after a key change still holds the
  // previous key's data, so a dropdown switching between two resources shows the
  // old one for a beat. A result tagged with a key nobody is asking about any
  // more is simply not returned.
  it('never hands back a result belonging to a previous key', async () => {
    const { result, rerender } = renderHook(({ k }) => useResource(k, () => Promise.resolve(`data-for-${k}`)), {
      initialProps: { k: 'a' },
    });

    await waitFor(() => expect(result.current.data).toBe('data-for-a'));

    rerender({ k: 'b' });

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.data).toBe('data-for-b'));
  });

  it('aborts the in-flight request when the key changes', async () => {
    const signals: AbortSignal[] = [];
    const { rerender } = renderHook(
      ({ k }) =>
        useResource(k, (signal) => {
          signals.push(signal);
          return new Promise<string>(() => {});
        }),
      { initialProps: { k: 'a' } },
    );

    rerender({ k: 'b' });

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  // An abort is this hook cleaning up after itself. Surfacing it as an error
  // would paint a failure banner every time a user changed their mind quickly.
  it('does not report an abort as an error', async () => {
    const { result } = renderHook(() =>
      useResource('a', () => Promise.reject(new DOMException('aborted', 'AbortError'))),
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
  });

  it('runs the loader again on refetch, holding the current data until the new one lands', async () => {
    let n = 0;
    const { result } = renderHook(() => useResource('a', () => Promise.resolve(`call-${++n}`)));

    await waitFor(() => expect(result.current.data).toBe('call-1'));

    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toBe('call-2'));
  });

  // A loader whose identity changes every render must not restart the request,
  // or an inline arrow at the call site becomes an infinite fetch loop.
  it('does not refetch when only the loader identity changes', async () => {
    const load = vi.fn().mockResolvedValue('x');
    const { result, rerender } = renderHook(() => useResource('a', (signal) => load(signal)));

    await waitFor(() => expect(result.current.status).toBe('done'));
    rerender();
    rerender();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
