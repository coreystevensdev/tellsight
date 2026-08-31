import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    DATABASE_ADMIN_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    CLAUDE_API_KEY: 'sk-ant-test',
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_WEBHOOK_SECRET: 'whsec_x',
    STRIPE_PRICE_ID: 'price_x',
    GOOGLE_CLIENT_ID: 'gci',
    GOOGLE_CLIENT_SECRET: 'gcs',
    JWT_SECRET: 'j'.repeat(32),
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    EMAIL_FROM_ADDRESS: 'insights@kiln.test.local',
    EMAIL_MAILING_ADDRESS: '500 Test Ave, Denver, CO 80202',
  });
});

const mockVerifyAccessToken = vi.fn();
vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

const mockTrackEvent = vi.fn();
vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
  trackEventSystem: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { analyticsRouter } = await import('./analytics.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/analytics', analyticsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());

function authed() {
  mockVerifyAccessToken.mockResolvedValueOnce({
    sub: '7',
    org_id: 3,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  });
  return { Cookie: 'access_token=valid-jwt', 'Content-Type': 'application/json' };
}

async function post(body: unknown) {
  return fetch(`${baseUrl}/analytics/events`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify(body),
  });
}

describe('POST /analytics/events', () => {
  it('records an allowlisted event', async () => {
    const res = await post({ eventName: 'dashboard.viewed', metadata: { source: 'nav' } });

    expect(res.status).toBe(200);
    expect(mockTrackEvent).toHaveBeenCalledWith(3, 7, 'dashboard.viewed', { source: 'nav' });
  });

  it('rejects an event name outside the allowlist', async () => {
    const res = await post({ eventName: 'totally.made.up' });

    expect(res.status).toBe(400);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing event name', async () => {
    const res = await post({ metadata: { a: 1 } });

    expect(res.status).toBe(400);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  // metadata lands in a jsonb column as-is. Parameterised, so not an injection
  // route, but an authenticated caller could otherwise push unbounded blobs in.
  describe('metadata bounds', () => {
    it('rejects metadata larger than the cap', async () => {
      const res = await post({
        eventName: 'dashboard.viewed',
        metadata: { blob: 'x'.repeat(5000) },
      });

      expect(res.status).toBe(400);
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('rejects a non-object metadata', async () => {
      const res = await post({ eventName: 'dashboard.viewed', metadata: 'not-an-object' });

      expect(res.status).toBe(400);
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('rejects an array, which typeof would otherwise call an object', async () => {
      const res = await post({ eventName: 'dashboard.viewed', metadata: [1, 2, 3] });

      expect(res.status).toBe(400);
      expect(mockTrackEvent).not.toHaveBeenCalled();
    });

    it('accepts an event with no metadata at all', async () => {
      const res = await post({ eventName: 'dashboard.viewed' });

      expect(res.status).toBe(200);
      expect(mockTrackEvent).toHaveBeenCalledWith(3, 7, 'dashboard.viewed', undefined);
    });
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await fetch(`${baseUrl}/analytics/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName: 'dashboard.viewed' }),
    });

    expect(res.status).toBe(401);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
