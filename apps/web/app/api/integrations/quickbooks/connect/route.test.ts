import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The nonce cookie has to reach the browser or the callback's nonce check
// fails and no QuickBooks connection can ever complete. Swapping this route to
// the plain proxyPost helper does exactly that, silently, which is why the
// assertion is on the cookie rather than on the response body.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function request() {
  return new NextRequest('http://localhost/api/integrations/quickbooks/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'access_token=abc' },
  });
}

function upstream(body: unknown, cookies: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

beforeEach(() => fetchMock.mockReset());

describe('POST /api/integrations/quickbooks/connect', () => {
  it('forwards the nonce cookie the callback checks', async () => {
    fetchMock.mockResolvedValue(
      upstream({ data: { authUrl: 'https://appcenter.intuit.com/connect/oauth2?x=1' } }, [
        'quickbooks_oauth_nonce=abc123; Path=/; HttpOnly',
      ]),
    );

    const res = await POST(request());

    expect(res.headers.getSetCookie()).toEqual([
      'quickbooks_oauth_nonce=abc123; Path=/; HttpOnly',
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api:3001/integrations/quickbooks/connect');
  });

  it('carries nothing identifying the org back to the browser', async () => {
    fetchMock.mockResolvedValue(
      upstream({ data: { authUrl: 'https://example.test/auth' } }, [
        'quickbooks_oauth_nonce=abc123; Path=/; HttpOnly',
      ]),
    );

    const res = await POST(request());
    const seen = res.headers.getSetCookie().join(' ') + JSON.stringify(await res.json());

    expect(seen).not.toMatch(/org[_-]?id/i);
    expect(seen).not.toMatch(/user[_-]?id/i);
  });
});
