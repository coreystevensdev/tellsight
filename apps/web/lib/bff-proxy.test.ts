import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxyGet, proxyPost, proxyPut, proxyPatch, proxyPostWithCookies, upstreamSignal, UPSTREAM_TIMEOUT_MS } from './bff-proxy';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const helpers = [
  { name: 'proxyGet', tag: '[bff-proxy:get]', build: () => proxyGet('/whatever'), method: 'GET' },
  { name: 'proxyPost', tag: '[bff-proxy:post]', build: () => proxyPost('/whatever'), method: 'POST' },
  { name: 'proxyPut', tag: '[bff-proxy:put]', build: () => proxyPut('/whatever'), method: 'PUT' },
  // Backs the live PATCH handler at app/api/proposals/[id]/route.ts.
  { name: 'proxyPatch', tag: '[bff-proxy:patch]', build: () => proxyPatch('/whatever'), method: 'PATCH' },
  { name: 'proxyPostWithCookies', tag: '[bff-proxy:post-with-cookies]', build: () => proxyPostWithCookies('/whatever'), method: 'POST' },
];

describe.each(helpers)('$name parse hardening', ({ name, tag, build, method }) => {
  // Only proxyPostWithCookies forwards Set-Cookie on the invalidResponse fallback path,
  // so the collapse-case mocks below carry a cookie to prove the other helpers don't pick it up.
  const expectedCookies = (name === 'proxyPostWithCookies' ? ['session=; Max-Age=0'] : []);

  const request = () => new NextRequest('http://localhost/api/whatever', { method, body: method === 'GET' ? undefined : '{}' });

  it('returns 502 UPSTREAM_UNAVAILABLE when fetch rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchErr = new Error('connection refused');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(fetchErr);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`${tag} upstream unreachable`, fetchErr);
  });

  it('surfaces the real upstream status when a non-2xx, non-null-body response is unparseable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parseErr = new SyntaxError('Unexpected token < in JSON');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(parseErr),
      headers: { getSetCookie: () => ['session=; Max-Age=0'] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
    expect(res.headers.getSetCookie()).toEqual(expectedCookies);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`${tag} upstream returned non-JSON body`, parseErr);
  });

  it('collapses to 502 when a 2xx response is unparseable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('aborted')),
      headers: { getSetCookie: () => ['session=; Max-Age=0'] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
    expect(res.headers.getSetCookie()).toEqual(expectedCookies);
  });

  it('collapses to 502 when a null-body status (204) is unparseable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 204,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      headers: { getSetCookie: () => ['session=; Max-Age=0'] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
    expect(res.headers.getSetCookie()).toEqual(expectedCookies);
  });

  // 204/205 are already caught by the res.ok branch of the collapse check in
  // any real Response (both sit inside the 200-299 range) -- 304 is the only
  // status where NULL_BODY_STATUSES itself is load-bearing.
  it('collapses to 502 when a null-body status (304) is unparseable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 304,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      headers: { getSetCookie: () => ['session=; Max-Age=0'] },
    } as unknown as Response);

    const res = await build()(request());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: 'UPSTREAM_INVALID_RESPONSE', message: 'API server returned an invalid response' },
    });
    expect(res.headers.getSetCookie()).toEqual(expectedCookies);
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

  it('sends the expected method, cookie header, and body to fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: { getSetCookie: () => [] },
    } as unknown as Response);

    const req = new NextRequest('http://localhost/api/whatever', {
      method,
      headers: { Cookie: 'session=abc123' },
      body: method === 'GET' ? undefined : '{}',
    });
    const expectedBody = method === 'GET' ? undefined : await req.clone().text();

    await build()(req);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.body).toBe(expectedBody);
    // Normalize to 'GET': proxyGet omits the method key entirely rather than
    // setting it to 'GET', but both mean the same thing to fetch.
    expect(init?.method ?? 'GET').toBe(method);

    if (method === 'GET') {
      expect(init?.headers).toEqual({ Cookie: 'session=abc123' });
    } else {
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Cookie: 'session=abc123' });
    }
  });

  it.skipIf(method === 'GET')('forwards an empty request body without defaulting it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: { getSetCookie: () => [] },
    } as unknown as Response);

    await build()(new NextRequest('http://localhost/api/whatever', { method, body: '' }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.body).toBe('');
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

describe('proxyPostWithCookies invalid-response cookie forwarding', () => {
  it('forwards Set-Cookie headers when the invalid-response fallback path fires', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      headers: { getSetCookie: () => ['session=; Max-Age=0'] },
    } as unknown as Response);

    const res = await proxyPostWithCookies('/whatever')(
      new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual(['session=; Max-Age=0']);
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

  it.each(helpers)(
    '$name resolves to the existing 502 UPSTREAM_UNAVAILABLE shape when the request arrives with an already-aborted signal',
    async ({ build, method }) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
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

      const request = new NextRequest('http://localhost/api/whatever', {
        method,
        body: method === 'GET' ? undefined : '{}',
      });
      const controller = new AbortController();
      controller.abort();
      Object.defineProperty(request, 'signal', { value: controller.signal });

      const res = await build()(request);

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'API server unreachable' },
      });
    },
  );
});
