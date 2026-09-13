// @vitest-environment node
//
// proxy.ts runs on the server, and jsdom's TextEncoder produces a Uint8Array
// from a different realm, which jose rejects on an instanceof check.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// proxy.ts is the only thing standing between a signed-out visitor and /upload,
// /billing, /admin and /settings, and it had no test at all: emptying
// PROTECTED_ROUTES or config.matcher left the whole web suite green.

const SECRET = 'k'.repeat(32);
const env = { API_INTERNAL_URL: 'http://api:3001', JWT_SECRET: SECRET, NODE_ENV: 'test' };

vi.mock('@/lib/config', () => ({ webEnv: env }));

const { proxy, config } = await import('./proxy');

// The routes proxy is responsible for, written down rather than imported, so
// shrinking the list in the source shows up here as a failure instead of as
// silence.
const PROTECTED = ['/upload', '/billing', '/admin', '/settings'];

function request(pathname: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${pathname}`, {
    headers: cookie ? { cookie } : {},
  });
}

function sign(payload: Record<string, unknown>, expires = '15m') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(new TextEncoder().encode(SECRET));
}

function redirectTarget(res: Response): URL | null {
  const location = res.headers.get('location');
  return location ? new URL(location) : null;
}

describe('proxy route protection', () => {
  it.each(PROTECTED)('sends a signed-out visitor on %s to login', async (route) => {
    const res = await proxy(request(route));

    const target = redirectTarget(res);
    expect(target?.pathname).toBe('/login');
    expect(target?.searchParams.get('redirect')).toBe(route);
  });

  it.each(PROTECTED)('protects nested paths under %s too', async (route) => {
    const res = await proxy(request(`${route}/anything/deeper`));
    expect(redirectTarget(res)?.pathname).toBe('/login');
  });

  // A prefix match on the bare string would catch /uploadable and /settings-old.
  it.each(['/uploader', '/billinghistory', '/administration', '/settingsx'])(
    'does not treat %s as protected on a prefix collision',
    async (route) => {
      const res = await proxy(request(route));
      expect(redirectTarget(res)).toBeNull();
    },
  );

  // The dashboard is public on purpose and a redirect here would break the
  // no-account demo path, which is the product's whole front door.
  it.each(['/', '/dashboard', '/dashboard/anything', '/login', '/share/abc123'])(
    'lets %s through untouched',
    async (route) => {
      const res = await proxy(request(route));
      expect(redirectTarget(res)).toBeNull();
      expect(res.status).toBe(200);
    },
  );
});

describe('proxy token handling', () => {
  it('lets a valid non-admin token into a non-admin protected route', async () => {
    const token = await sign({ sub: '7', org_id: 3, isAdmin: false });
    const res = await proxy(request('/upload', `access_token=${token}`));

    expect(redirectTarget(res)).toBeNull();
  });

  it('sends a non-admin away from /admin', async () => {
    const token = await sign({ sub: '7', org_id: 3, isAdmin: false });
    const res = await proxy(request('/admin', `access_token=${token}`));

    expect(redirectTarget(res)?.pathname).toBe('/dashboard');
  });

  it('sends a non-admin away from a nested admin route', async () => {
    const token = await sign({ sub: '7', org_id: 3, isAdmin: false });
    const res = await proxy(request('/admin/health', `access_token=${token}`));

    expect(redirectTarget(res)?.pathname).toBe('/dashboard');
  });

  it('lets a platform admin into /admin', async () => {
    const token = await sign({ sub: '1', org_id: 1, isAdmin: true });
    const res = await proxy(request('/admin', `access_token=${token}`));

    expect(redirectTarget(res)).toBeNull();
  });

  it('sends a garbage token to login rather than throwing', async () => {
    const res = await proxy(request('/upload', 'access_token=not-a-jwt'));

    expect(redirectTarget(res)?.pathname).toBe('/login');
  });

  it('sends an expired token to login', async () => {
    const token = await sign({ sub: '7', isAdmin: false }, '-1s');
    const res = await proxy(request('/upload', `access_token=${token}`));

    expect(redirectTarget(res)?.pathname).toBe('/login');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await new SignJWT({ sub: '7', isAdmin: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('x'.repeat(32)));

    const res = await proxy(request('/admin', `access_token=${token}`));
    expect(redirectTarget(res)?.pathname).toBe('/login');
  });
});

describe('proxy configuration', () => {
  // Without a secret the verify branch is skipped entirely, so in production
  // every cookie-bearing request would sail through unverified. Failing closed
  // is the only safe answer, and nothing asserted it.
  it('fails closed in production when JWT_SECRET is missing', async () => {
    const original = { ...env };
    Object.assign(env, { JWT_SECRET: undefined, NODE_ENV: 'production' });

    try {
      const token = await sign({ sub: '7', isAdmin: false });
      const res = await proxy(request('/admin', `access_token=${token}`));
      expect(res.status).toBe(500);
    } finally {
      Object.assign(env, original);
    }
  });

  // proxy() can be perfectly correct and never run. Next only invokes it for
  // paths the matcher selects, so an empty or trimmed matcher disables route
  // protection without failing any test that calls proxy() directly. Exact
  // equality rather than containment, so a trimmed entry fails here.
  //
  // /dashboard is in the matcher to mint a session, never to guard one. It stays
  // public, which the redirect tests above pin from the other side.
  it('has a matcher entry covering every protected route, plus the dashboard', () => {
    expect(config.matcher).toEqual(
      [...PROTECTED, '/dashboard'].map((route) => `${route}/:path*`),
    );
  });
});

// A route with no layout.tsx does not error, it silently inherits the nearest
// ancestor, which for a top-level route is app/layout.tsx: fonts, theme, toaster,
// no navigation. /upload and /billing shipped that way and rendered with no
// sidebar, no header and no back link on any viewport, with nothing failing.
//
// The route list is read out of proxy.ts rather than imported, because a static
// import of this module fires the '@/lib/config' mock factory above before its
// env const initializes, and it.each needs the array at collection time.
describe('protected routes render app chrome', () => {
  const source = readFileSync(join(import.meta.dirname, 'proxy.ts'), 'utf8');
  const declaration = source.match(/PROTECTED_ROUTES = \[([^\]]*)\]/);
  const routes = (declaration?.[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/'/g, ''))
    .filter(Boolean);

  // Without this the whole block passes vacuously if the const is ever renamed.
  it('found the route list to check', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('%s has its own layout rather than inheriting the root', (route) => {
    expect(existsSync(join(import.meta.dirname, 'app', route, 'layout.tsx'))).toBe(true);
  });
});

// An access cookie whose max-age matches the 15-minute JWT leaves a signed-in
// owner looking anonymous to the server render, and the charts route answers an
// unauthenticated request with the seed org. Reproduced in a browser before this
// was written: drop only the access cookie, reload /dashboard, and the page came
// back showing Sunrise Cafe's revenue to someone who had never uploaded anything.
describe('proxy session refresh', () => {
  const MINTED = [
    'refresh_token=rotated; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800000; Expires=Sun, 20 Sep 2026 15:00:00 GMT',
  ];

  // A real Headers, not an object answering getSetCookie alone: the stand-in
  // would throw rather than fail usefully the first time proxy.ts read any other
  // header. It also means MINTED's Expires, which contains a comma, goes through
  // the same set-cookie handling the runtime uses, so the array getSetCookie
  // returns is the real one rather than one the fixture asserted into existence.
  function mockRefresh(accessToken: string | null) {
    const headers = new Headers();
    if (accessToken !== null) {
      headers.append('set-cookie', `access_token=${accessToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900000`);
      for (const line of MINTED) headers.append('set-cookie', line);
    }

    const fetchMock = vi.fn().mockResolvedValue({ ok: accessToken !== null, headers });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints a session for /dashboard when the access cookie has aged out', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));

    const res = await proxy(request('/dashboard', 'refresh_token=r1'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/auth/refresh');
    expect(res.headers.getSetCookie().join(' ')).toContain('access_token=');
    expect(redirectTarget(res)).toBeNull();
  });

  // Setting the cookie on the response only tells the browser. The server render
  // of this same request reads the cookie jar it was handed, so without
  // NextResponse.next({ request }) it still sees no access token and still serves
  // the seed org, with a correct Set-Cookie riding along on the response. That is
  // the bug wearing a fix. Next exposes the rewritten jar as an internal header,
  // so this asserts against x-middleware-request-cookie on purpose: if an upgrade
  // renames it, this should fail loudly rather than quietly check nothing.
  it('hands the minted token to the server render, not only to the browser', async () => {
    const access = await sign({ org_id: 2, sub: '1' });
    mockRefresh(access);

    const res = await proxy(request('/dashboard', 'refresh_token=r1'));

    expect(res.headers.get('x-middleware-override-headers')).toContain('cookie');
    expect(res.headers.get('x-middleware-request-cookie')).toContain(`access_token=${access}`);
  });

  // The rotated refresh token only exists in the database once the API has minted
  // it. A response that drops the Set-Cookie leaves the browser holding the
  // revoked one, and presenting that is what the API reads as reuse, which
  // revokes every session the user has. So every exit has to carry the cookies,
  // including the ones that redirect.
  it('forwards the rotated cookies on a redirect, not just on a rendered page', async () => {
    mockRefresh(await sign({ org_id: 2, sub: '1', isAdmin: false }));

    const res = await proxy(request('/admin', 'refresh_token=r1'));

    expect(redirectTarget(res)?.pathname).toBe('/dashboard');
    expect(res.headers.getSetCookie().join(' ')).toContain('refresh_token=rotated');
  });

  it('lets an expired protected-route session through instead of bouncing it to login', async () => {
    mockRefresh(await sign({ org_id: 2, sub: '1' }));

    const res = await proxy(request('/upload', 'refresh_token=r1'));

    expect(redirectTarget(res)).toBeNull();
  });

  // Prefetch fires on hover and on viewport entry. Rotating from one hands the
  // cookie to a response the router can discard, and two in flight together look
  // like reuse.
  it.each([
    ['next-router-prefetch', '1'],
    ['purpose', 'prefetch'],
  ])('does not mint on a %s request', async (header, value) => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));
    const req = new NextRequest('http://localhost:3000/upload', {
      headers: { cookie: 'refresh_token=r1', [header]: value },
    });

    const res = await proxy(req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(redirectTarget(res)?.pathname).toBe('/login');
  });

  it('leaves /dashboard public when the refresh fails', async () => {
    mockRefresh(null);

    const res = await proxy(request('/dashboard', 'refresh_token=stale'));

    expect(redirectTarget(res)).toBeNull();
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('renders rather than failing when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const res = await proxy(request('/dashboard', 'refresh_token=r1'));

    expect(redirectTarget(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it('does not call the API for a visitor with no refresh cookie', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));

    await proxy(request('/dashboard'));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call the API when the access token is still good', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));
    // Expiry stated rather than inherited from sign()'s default, which could be
    // changed to something in the past and leave this passing under its old name.
    const token = await sign({ org_id: 2, sub: '1' }, '1h');

    await proxy(request('/dashboard', `access_token=${token}; refresh_token=r1`));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints when the access token is present but expired', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));
    const expired = await sign({ org_id: 2, sub: '1' }, '-1s');

    await proxy(request('/dashboard', `access_token=${expired}; refresh_token=r1`));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A local dev server started without JWT_SECRET cannot check authenticity, and
  // the first version of this answered that by calling any present token usable.
  // That made dev the one place the expired-token path never ran, which is how
  // the bug this file fixes stayed invisible in the first place. Expiry is
  // readable without the secret, so it is read.
  it('mints an expired token even with no secret to verify against', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));
    const expired = await sign({ org_id: 2, sub: '1' }, '-1s');
    const original = { ...env };
    Object.assign(env, { JWT_SECRET: undefined });

    try {
      await proxy(request('/dashboard', `access_token=${expired}; refresh_token=r1`));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.assign(env, original);
    }
  });

  // The opposite mistake costs more than the one above. Treating every
  // unverifiable token as stale would rotate the refresh token on every single
  // request, and rotation plus reuse detection is a logout generator.
  it('leaves a live token alone with no secret, rather than rotating every request', async () => {
    const fetchMock = mockRefresh(await sign({ org_id: 2, sub: '1' }));
    const live = await sign({ org_id: 2, sub: '1' }, '1h');
    const original = { ...env };
    Object.assign(env, { JWT_SECRET: undefined });

    try {
      await proxy(request('/dashboard', `access_token=${live}; refresh_token=r1`));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.assign(env, original);
    }
  });
});
