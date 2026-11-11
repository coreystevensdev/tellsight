import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Same nonce-cookie requirement as the other two connectors, plus the body:
// a Shopify authorize URL is per-shop, so /connect needs the shop domain and
// dropping the body would break the flow before the cookie ever mattered.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const { POST } = await import('./route');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function request(body = { shop: 'acme.myshopify.com' }) {
  return new NextRequest('http://localhost/api/integrations/shopify/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'access_token=abc' },
    body: JSON.stringify(body),
  });
}

function upstream(body: unknown, cookies: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

beforeEach(() => fetchMock.mockReset());

describe('POST /api/integrations/shopify/connect', () => {
  it('forwards the nonce cookie the callback checks', async () => {
    fetchMock.mockResolvedValue(
      upstream({ data: { authUrl: 'https://acme.myshopify.com/admin/oauth/authorize?x=1' } }, [
        'shopify_oauth_nonce=abc123; Path=/; HttpOnly',
      ]),
    );

    const res = await POST(request());

    expect(res.headers.getSetCookie()).toEqual(['shopify_oauth_nonce=abc123; Path=/; HttpOnly']);
  });

  it('passes the shop domain upstream, since the authorize URL is per shop', async () => {
    fetchMock.mockResolvedValue(upstream({ data: { authUrl: 'https://example.test/auth' } }));

    await POST(request({ shop: 'acme.myshopify.com' }));

    const init = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ shop: 'acme.myshopify.com' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://api:3001/integrations/shopify/connect');
  });

  it('carries nothing identifying the org back to the browser', async () => {
    fetchMock.mockResolvedValue(
      upstream({ data: { authUrl: 'https://example.test/auth' } }, [
        'shopify_oauth_nonce=abc123; Path=/; HttpOnly',
      ]),
    );

    const res = await POST(request());
    const seen = res.headers.getSetCookie().join(' ') + JSON.stringify(await res.json());

    expect(seen).not.toMatch(/org[_-]?id/i);
    expect(seen).not.toMatch(/user[_-]?id/i);
  });
});
