import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mockVerify = vi.fn();

vi.mock('../config.js', () => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    APP_URL: 'https://app.test',
    PUBLIC_API_URL: 'https://api.test',
    JWT_SECRET: 'a'.repeat(64),
    NODE_ENV: 'test',
    EMAIL_FROM_ADDRESS: 'digest@test',
    EMAIL_FROM_NAME: 'Tellsight',
    EMAIL_MAILING_ADDRESS: '1 Real St',
    STRIPE_SECRET_KEY: 'sk_test',
    ENCRYPTION_KEY: 'b'.repeat(64),
  },
}));
// child() included deliberately. Without it the first router to call it throws a
// TypeError before authMiddleware's AuthenticationError can form, every prefix
// answers 500, and the boundary reads as broken when the harness is what is
// incomplete.
const makeLogger = (): Record<string, unknown> => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: () => makeLogger(),
});
vi.mock('../lib/logger.js', () => ({ logger: makeLogger() }));
vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: (...a: unknown[]) => mockVerify(...a),
}));
// errorHandler reports through Sentry, and sentryUserContext is mounted on the
// router itself. Unmocked, the real module's init runs and the handler that
// should turn AuthenticationError into a 401 throws on the way, so every
// assertion here sees a 500 and the boundary looks broken when it is not.
vi.mock('../lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withScope: vi.fn(async (cb: (s: { setTag: () => void }) => unknown) => cb({ setTag: vi.fn() })),
    setUser: vi.fn(),
  },
  sentryUserContext: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const protectedRouter = (await import('./protected.js')).default;

// Read the mount list out of the source rather than restating it here. A router
// added to protected.ts is covered by this suite the moment it is mounted, which
// is the only way a boundary test stays true as the surface grows. Importing the
// router object instead would give us Express internals, not the author's intent.
const SOURCE = readFileSync(fileURLToPath(new URL('./protected.ts', import.meta.url)), 'utf8');
const MOUNTED_PREFIXES = [...SOURCE.matchAll(/protectedRouter\.use\(\s*'([^']+)'/g)].map((m) => m[1]!);
const UNIQUE_PREFIXES = [...new Set(MOUNTED_PREFIXES)];

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(protectedRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('protected router auth boundary', () => {
  // The runtime checks below cannot see this. A router mounted above the
  // authMiddleware line serves its own paths without a token, but a request to
  // the bare prefix usually matches no route there and falls through to the
  // protected mount, which then answers 401 and the suite goes green. Verified:
  // moving one mount above the middleware passes every other test in this file.
  // The ordering is the invariant, so the ordering is what gets asserted.
  it('mounts authMiddleware before every router', () => {
    const authAt = SOURCE.indexOf('protectedRouter.use(authMiddleware)');
    const firstRouterAt = SOURCE.search(/protectedRouter\.use\(\s*'/);

    expect(authAt).toBeGreaterThan(-1);
    expect(firstRouterAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(firstRouterAt);
  });

  it('found the mount list in the source', () => {
    // Guards the regex itself. If protected.ts is reformatted and this stops
    // matching, every assertion below would pass over an empty list and the
    // suite would go green while testing nothing.
    expect(UNIQUE_PREFIXES.length).toBeGreaterThanOrEqual(12);
    expect(UNIQUE_PREFIXES).toContain('/admin');
  });

  // The regression this exists for: a router mounted above the authMiddleware
  // line is served without a token and nothing else in the suite would notice,
  // because every route test mounts its own router behind its own middleware.
  it.each(UNIQUE_PREFIXES)('%s refuses a request with no access token', async (prefix) => {
    const res = await fetch(`${baseUrl}${prefix}`);

    expect(res.status).toBe(401);
  });
});

describe('admin role boundary', () => {
  // /admin carries roleGuard on top of authMiddleware. A valid token is not
  // enough, which is the distinction between authentication and authorization
  // and the one most often collapsed.
  it('refuses a signed-in non-admin', async () => {
    mockVerify.mockResolvedValueOnce({ sub: '7', org_id: 10, role: 'owner', isAdmin: false });

    const res = await fetch(`${baseUrl}/admin/orgs`, { headers: { Cookie: 'access_token=t' } });

    expect(res.status).toBe(403);
  });
});
