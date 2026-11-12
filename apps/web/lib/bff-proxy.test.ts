import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxyGet, proxyPost, proxyPut, proxyPatch, proxyDelete, proxyPostWithCookies, upstreamSignal, UPSTREAM_TIMEOUT_MS, forwardedFor, MAX_BODY_BYTES } from './bff-proxy';

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
  // Backs the three integration disconnects, which each hand-rolled this before
  // the helper existed and so had no timeout and no guard on a non-JSON body.
  { name: 'proxyDelete', tag: '[bff-proxy:delete]', build: () => proxyDelete('/whatever'), method: 'DELETE' },
  { name: 'proxyPostWithCookies', tag: '[bff-proxy:post-with-cookies]', build: () => proxyPostWithCookies('/whatever'), method: 'POST' },
];

describe.each(helpers)('$name parse hardening', ({ name, tag, build, method }) => {
  // Only proxyPostWithCookies forwards Set-Cookie on the invalidResponse fallback path,
  // so the collapse-case mocks below carry a cookie to prove the other helpers don't pick it up.
  const expectedCookies = (name === 'proxyPostWithCookies' ? ['session=; Max-Age=0'] : []);

  const request = () => new NextRequest('http://localhost/api/whatever', { method, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });

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
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    });
    // DELETE forwards no body, same as GET: none of the five callers send one.
    const expectedBody = method === 'GET' || method === 'DELETE' ? undefined : await req.clone().text();

    await build()(req);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.body).toBe(expectedBody);
    // Normalize to 'GET': proxyGet omits the method key entirely rather than
    // setting it to 'GET', but both mean the same thing to fetch.
    expect(init?.method ?? 'GET').toBe(method);

    // The bodyless helpers send no Content-Type, because there is no content.
    if (method === 'GET' || method === 'DELETE') {
      expect(init?.headers).toEqual({ Cookie: 'session=abc123' });
    } else {
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Cookie: 'session=abc123' });
    }
  });

  it.skipIf(method === 'GET' || method === 'DELETE')('forwards an empty request body without defaulting it', async () => {
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
  it('aborts on its own once the timeout elapses, with no client-side abort', async () => {
    const request = new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' });

    // Real timer at 20ms rather than fake timers at UPSTREAM_TIMEOUT_MS:
    // AbortSignal.timeout runs on a native timer that vi.advanceTimersByTime
    // does not reach, so faking it asserts nothing.
    const signal = upstreamSignal(request, 20);
    expect(signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(signal.aborted).toBe(true);
    expect(request.signal.aborted).toBe(false);
  });

  it('carries the 60s upstream timeout by default', () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    upstreamSignal(new NextRequest('http://localhost/api/whatever', { method: 'POST', body: '{}' }));
    expect(timeout).toHaveBeenCalledWith(UPSTREAM_TIMEOUT_MS);
    timeout.mockRestore();
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
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
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

// Express keys its IP rate limiters on req.ip, and every request from this
// layer arrives on the same docker-bridge socket. Dropping X-Forwarded-For made
// req.ip the web container for the whole app, so one visitor clicking around
// the integrations page could 429 everyone.
describe('forwardedFor', () => {
  it('passes the header through unchanged so the appended caller stays last', () => {
    const req = new NextRequest('http://localhost/api/whatever', {
      headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' },
    });

    expect(forwardedFor(req)).toEqual({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
  });

  it('omits the header entirely when there is none, rather than sending an empty one', () => {
    // An empty value is not the same as absent: it would add a blank entry to
    // the address list Express walks.
    expect(forwardedFor(new NextRequest('http://localhost/api/whatever'))).toEqual({});
  });

  it('is spreadable into any header object without disturbing it', () => {
    const req = new NextRequest('http://localhost/api/whatever');
    expect({ cookie: 'a=b', ...forwardedFor(req) }).toEqual({ cookie: 'a=b' });
  });
});

describe('proxy helpers forward the caller address', () => {
  it('sends x-forwarded-for upstream alongside the cookie', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { ok: true } }),
      headers: { getSetCookie: () => [] },
    } as unknown as Response);

    await proxyGet('/whatever')(
      new NextRequest('http://localhost/api/whatever', {
        headers: { Cookie: 'session=abc123', 'x-forwarded-for': '203.0.113.7' },
      }),
    );

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init?.headers).toEqual({
      Cookie: 'session=abc123',
      'x-forwarded-for': '203.0.113.7',
    });
  });
})

// Every one of these buffered the whole body into a JS string with no ceiling,
// and two of their callers (track/digest/click, track/alert/click) sit outside
// the IP rate limiter on purpose, so one unauthenticated request could decide
// how much memory the Next process allocated.
const bodyHelpers = helpers.filter((h) => h.method !== 'GET' && h.method !== 'DELETE');

describe.each(bodyHelpers)('$name body ceiling', ({ build, method }) => {
  const url = 'http://localhost/api/whatever';

  // An in-process NextRequest carries no content-length, so this one goes
  // through the running count rather than the header fast path.
  it('refuses an oversized body and never calls upstream', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await build()(new NextRequest(url, { method, body: 'x'.repeat(MAX_BODY_BYTES + 1) }));

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The header fast path, which the case above cannot reach. A real HTTP request
  // declares its length, and rejecting on it means never reading the socket.
  it('refuses on a declared content-length without reading the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = new NextRequest(url, {
      method,
      body: 'small',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
    });

    const res = await build()(request);

    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
  });

  // The content-length check alone is not enough: a chunked request declares no
  // length, so the bytes have to be counted as they arrive or the ceiling is
  // trivially skipped by omitting the header.
  it('counts streamed bytes when no content-length is declared', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const chunk = new TextEncoder().encode('y'.repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const res = await build()(
      // duplex is required for a stream body and is absent from Next's own
      // RequestInit type, so the cast targets the constructor's parameter.
      new NextRequest(url, {
        method,
        body,
        duplex: 'half',
      } as unknown as ConstructorParameters<typeof NextRequest>[1]),
    );

    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards a body under the ceiling byte for byte', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"data":1}', { status: 200 }));

    const res = await build()(new NextRequest(url, { method, body: '{"q":"hello"}' }));

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: '{"q":"hello"}' });
  });

  // request.text() returned '' for a bodyless POST and several callers rely on
  // that, so the replacement has to keep doing it.
  it('still forwards an empty body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const res = await build()(new NextRequest(url, { method, body: '' }));

    expect(res.status).toBe(200);
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ body: '' });
  });
});
