import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxyPost, upstreamSignal, UPSTREAM_TIMEOUT_MS } from './bff-proxy';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('upstreamSignal', () => {
  it('aborts on its own once UPSTREAM_TIMEOUT_MS elapses, with no client-side abort', () => {
    vi.useFakeTimers();
    const request = new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' });

    const signal = upstreamSignal(request);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(UPSTREAM_TIMEOUT_MS);

    expect(signal.aborted).toBe(true);
  });

  it('resolves proxyPost to the existing 502 UPSTREAM_UNAVAILABLE shape when the request arrives with an already-aborted signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    });

    const request = new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' });
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(request, 'signal', { value: controller.signal });

    const res = await proxyPost('/whatever')(request);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
  });
});
