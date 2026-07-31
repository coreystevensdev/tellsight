import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxyGet, proxyPost, proxyPut, proxyPostWithCookies, upstreamSignal, UPSTREAM_TIMEOUT_MS } from './bff-proxy';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const helpers = [
  { name: 'proxyGet', build: () => proxyGet('/whatever'), method: 'GET' },
  { name: 'proxyPost', build: () => proxyPost('/whatever'), method: 'POST' },
  { name: 'proxyPut', build: () => proxyPut('/whatever'), method: 'PUT' },
  { name: 'proxyPostWithCookies', build: () => proxyPostWithCookies('/whatever'), method: 'POST' },
];

describe.each(helpers)('$name parse hardening', ({ build, method }) => {
  const request = () => new NextRequest('http://localhost/api/whatever', { method, body: method === 'GET' ? undefined : '{}' });

  it('returns 502 UPSTREAM_UNAVAILABLE when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connection refused'));

    const res = await build()(request());

    // UPSTREAM_ERROR_RESPONSE is a shared singleton across every helper and
    // test in this file, so clone() before reading -- a direct .json() call
    // would permanently consume the body for every later test.
    expect(res.status).toBe(502);
    expect(await res.clone().json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
  });

  it('surfaces the real upstream status when a non-2xx, non-null-body response is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  it('collapses to 502 when a 2xx response is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('aborted')),
      headers: { getSetCookie: () => [] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  it('collapses to 502 when a null-body status (204) is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 204,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  // 204/205 are already caught by the res.ok branch of the collapse check in
  // any real Response (both sit inside the 200-299 range) -- 304 is the only
  // status where NULL_BODY_STATUSES itself is load-bearing.
  it('collapses to 502 when a null-body status (304) is unparseable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 304,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
  });

  it('passes through valid JSON at the real upstream status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 201,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: { getSetCookie: () => [] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });
});

describe('proxyPostWithCookies success passthrough', () => {
  it('forwards Set-Cookie headers from the upstream response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: { getSetCookie: () => ['session=abc; HttpOnly', 'csrf=def'] },
    } as unknown as Response);

    const res = await proxyPostWithCookies('/whatever')(
      new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['session=abc; HttpOnly', 'csrf=def']);
  });
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

    // UPSTREAM_ERROR_RESPONSE is a shared singleton across every helper and
    // test in this file, so clone() before reading -- a direct .json() call
    // would permanently consume the body for every later test.
    expect(res.status).toBe(502);
    expect(await res.clone().json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
  });
});
