// @vitest-environment node
//
// proxy.ts runs on the server, and jsdom's TextEncoder produces a Uint8Array
// from a different realm, which jose rejects on an instanceof check.

import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

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
  // protection without failing any test that calls proxy() directly.
  it('has a matcher entry covering every protected route', () => {
    expect(config.matcher).toEqual(PROTECTED.map((route) => `${route}/:path*`));
  });
});
