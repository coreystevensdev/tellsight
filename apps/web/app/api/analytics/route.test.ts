import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// No test file existed, and `if (!upstream.ok)` → `if (false)` was green on the
// full web suite: every upstream failure then reported {data:{ok:true}} and the
// caller believed the event was recorded.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function track(body: unknown = { eventName: 'dashboard.viewed' }, raw?: string) {
  return new NextRequest('http://localhost/api/analytics', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'access_token=abc' },
    body: raw ?? JSON.stringify(body),
  });
}

function upstream(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => fetchMock.mockReset());

describe('POST /api/analytics', () => {
  it('forwards the event and the cookie', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: null }));

    await POST(track({ eventName: 'dashboard.viewed', metadata: { source: 'nav' } }));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api:3001/analytics/events');
    expect(init.headers).toMatchObject({ cookie: 'access_token=abc' });
    expect(JSON.parse(init.body)).toEqual({
      eventName: 'dashboard.viewed',
      metadata: { source: 'nav' },
    });
  });

  it('reports success only when the upstream succeeded', async () => {
    fetchMock.mockResolvedValueOnce(upstream({ data: null }));

    const res = await POST(track());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
  });

  // The failure that matters. Reporting ok on a rejected event means a caller
  // retrying on failure never retries, and the event is simply lost.
  it.each([
    [400, 400],
    [401, 401],
    [429, 429],
    [500, 502],
  ])('surfaces an upstream %s as %s rather than ok', async (upstreamStatus, expected) => {
    fetchMock.mockResolvedValueOnce(upstream({ error: { code: 'X', message: 'y' } }, upstreamStatus));

    const res = await POST(track());

    expect(res.status).toBe(expected);
    expect(await res.json()).not.toMatchObject({ data: { ok: true } });
  });

  it('rejects a malformed body before calling upstream', async () => {
    const res = await POST(track(undefined, '{not json'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'INVALID_BODY' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the API unreachable rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(track());

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'UPSTREAM_UNREACHABLE' } });
  });

  it('returns a shaped error when the failure body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>500</html>', { status: 500 }));

    expect(await (await POST(track())).json()).toMatchObject({ error: { code: 'UPSTREAM_ERROR' } });
  });
});
