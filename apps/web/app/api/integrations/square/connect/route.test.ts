import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Written because the mutation survived: swapping this route to the plain
// proxyPost helper drops Set-Cookie, and the whole OAuth flow then fails at the
// callback's state check with nothing in the logs pointing here.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function request(cookie = 'access_token=abc') {
  return new NextRequest('http://localhost/api/integrations/square/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
  });
}

function upstream(body: unknown, status = 200, cookies: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

beforeEach(() => fetchMock.mockReset());

describe('POST /api/integrations/square/connect', () => {
  // The state cookie is the only thing standing between the callback and a
  // forged redirect, because Square signs nothing. If it never reaches the
  // browser, every connection attempt fails the state check.
  it('forwards the OAuth cookies the callback will check', async () => {
    fetchMock.mockResolvedValue(
      upstream({ data: { authUrl: 'https://connect.squareupsandbox.com/oauth2/authorize?x=1' } }, 200, [
        'square_oauth_state=abc123; Path=/; HttpOnly',
        'square_oauth_org_id=3; Path=/; HttpOnly',
        'square_oauth_user_id=5; Path=/; HttpOnly',
      ]),
    );

    const res = await POST(request());
    const set = res.headers.getSetCookie();

    expect(set).toHaveLength(3);
    expect(set.join(' ')).toContain('square_oauth_state=abc123');
    expect(set.join(' ')).toContain('square_oauth_org_id=3');
  });

  it('passes the caller cookies upstream and returns the authorize URL', async () => {
    fetchMock.mockResolvedValue(upstream({ data: { authUrl: 'https://example.test/auth' } }));

    const res = await POST(request('access_token=xyz'));
    expect(await res.json()).toEqual({ data: { authUrl: 'https://example.test/auth' } });

    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Cookie).toContain('access_token=xyz');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api:3001/integrations/square/connect');
  });

  // 409 when already connected, 501 when the deployment has no credentials.
  // Both are answers the UI renders, not failures to swallow.
  it.each([409, 501])('passes a %s through rather than flattening it', async (status) => {
    fetchMock.mockResolvedValue(upstream({ error: { code: 'X', message: 'y' } }, status));
    expect((await POST(request())).status).toBe(status);
  });
});
