import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// No test file existed. Three mutations were green on the full 858-test web
// suite: deleting the Set-Cookie forwarding loop, collapsing the 5xx mapping,
// and the upstream JSON parse.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function upload(cookie = 'access_token=abc') {
  return new NextRequest('http://localhost/api/datasets', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=xyz', cookie },
    body: 'ignored',
  });
}

function upstream(body: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => fetchMock.mockReset());

describe('POST /api/datasets', () => {
  it('forwards the content type and cookie to the internal API', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: { rowCount: 3 } }));

    await POST(upload());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api:3001/datasets');
    expect(init.headers).toMatchObject({
      'content-type': 'multipart/form-data; boundary=xyz',
      cookie: 'access_token=abc',
    });
  });

  it('returns the upstream body verbatim', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: { rowCount: 3 } }));

    const res = await POST(upload());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { rowCount: 3 } });
  });

  // An upload can outlive the access token, so the refresh lands on this
  // response. Drop the forwarding and the browser keeps the old cookie: the
  // upload succeeds and the next request is unauthenticated.
  it('forwards every Set-Cookie the upstream sets', async () => {
    const rotated = [
      'access_token=new; Path=/; HttpOnly',
      'refresh_token=rotated; Path=/; HttpOnly',
    ];
    fetchMock.mockResolvedValueOnce(upstream({ data: {} }, 200, rotated));

    const res = await POST(upload());

    expect(res.headers.getSetCookie()).toEqual(rotated);
  });

  // A 500 from our own API is not something a browser should see as a 500 from
  // the BFF; 502 says the failure was upstream of this handler.
  it.each([
    [500, 502],
    [503, 502],
    [400, 400],
    [413, 413],
  ])('maps an upstream %s to %s', async (upstreamStatus, expected) => {
    fetchMock.mockResolvedValueOnce(upstream({ error: { code: 'X', message: 'y' } }, upstreamStatus));

    expect((await POST(upload())).status).toBe(expected);
  });

  // Gateway timeouts and proxy errors arrive as HTML, so the parse has to fail
  // into a shaped error rather than throwing out of the handler.
  it('returns a shaped error when the upstream body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>502</html>', { status: 502 }));

    const res = await POST(upload());

    expect(await res.json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } });
  });
});
