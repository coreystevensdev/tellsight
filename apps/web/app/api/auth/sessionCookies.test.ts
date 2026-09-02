// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Every one of these routes is a one-liner delegating to a bff-proxy helper, and
// none had a test. proxyPost and proxyPostWithCookies take the same argument and
// return the same type, so swapping one for the other passes lint, type-check
// and all 799 web tests, while login returns 200 with a user payload and no
// session cookie and logout never clears one.
//
// lib/bff-proxy.test.ts covers the helpers. What was missing is that these
// routes use the right one.

vi.mock('@/lib/config', () => ({
  webEnv: { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: 'k'.repeat(32), NODE_ENV: 'test' },
}));

const UPSTREAM_COOKIES = [
  'access_token=abc123; Path=/; HttpOnly; SameSite=Lax',
  'refresh_token=def456; Path=/; HttpOnly; SameSite=Lax',
];

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function upstreamResponse(cookies: string[] = UPSTREAM_COOKIES) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ data: { user: { id: 7 } } }), { status: 200, headers });
}

function post(path: string) {
  return new NextRequest(`http://localhost:3000/api/auth/${path}`, {
    method: 'POST',
    body: JSON.stringify({ email: 'a@b.test', password: 'x' }),
  });
}

// Every route that establishes or clears a session. forgot-password is
// deliberately absent, see below.
const SESSION_ROUTES = [
  'signin',
  'signup',
  'callback',
  'logout',
  'refresh',
  'reset-password',
] as const;

const importers: Record<(typeof SESSION_ROUTES)[number], () => Promise<{ POST: (r: NextRequest) => Promise<Response> }>> = {
  signin: () => import('./signin/route'),
  signup: () => import('./signup/route'),
  callback: () => import('./callback/route'),
  logout: () => import('./logout/route'),
  refresh: () => import('./refresh/route'),
  'reset-password': () => import('./reset-password/route'),
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('BFF auth routes forward the session cookie', () => {
  it.each(SESSION_ROUTES)('%s passes Set-Cookie through from the API', async (route) => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());
    const { POST } = await importers[route]();

    const res = await POST(post(route));

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(UPSTREAM_COOKIES);
  });

  it('forwards a cleared cookie on logout, not just a set one', async () => {
    const cleared = ['access_token=; Path=/; HttpOnly; Max-Age=0'];
    fetchMock.mockResolvedValueOnce(upstreamResponse(cleared));
    const { POST } = await importers.logout();

    const res = await POST(post('logout'));

    expect(res.headers.getSetCookie()).toEqual(cleared);
  });

  it('still returns the upstream body alongside the cookie', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());
    const { POST } = await importers.signin();

    const res = await POST(post('signin'));

    expect(await res.json()).toEqual({ data: { user: { id: 7 } } });
  });

  // The discriminating case. forgot-password answers identically whether or not
  // the address exists, and establishes no session, so it uses the plain helper
  // on purpose. If this ever forwards a cookie, someone has changed a route that
  // should not have one.
  it('does not forward cookies from forgot-password, which starts no session', async () => {
    fetchMock.mockResolvedValueOnce(upstreamResponse());
    const { POST } = await import('./forgot-password/route');

    const res = await POST(post('forgot-password'));

    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
