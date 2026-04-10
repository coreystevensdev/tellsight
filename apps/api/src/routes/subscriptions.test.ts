import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetActiveTier = vi.fn();
const mockGetSubscriptionByOrgId = vi.fn();
const mockCreateCheckoutSession = vi.fn();
const mockCreatePortalSession = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  subscriptionsQueries: {
    getActiveTier: mockGetActiveTier,
    getSubscriptionByOrgId: mockGetSubscriptionByOrgId,
  },
}));

vi.mock('../services/subscription/index.js', () => ({
  createCheckoutSession: mockCreateCheckoutSession,
  createPortalSession: mockCreatePortalSession,
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', APP_URL: 'http://localhost:3000' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { subscriptionsRouter } = await import('./subscriptions.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/subscriptions', subscriptionsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function ownerPayload() {
  return {
    sub: '1',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

function memberPayload() {
  return {
    sub: '2',
    org_id: 10,
    role: 'member',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

describe('GET /subscriptions/tier', () => {
  it('returns current tier', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetActiveTier.mockResolvedValueOnce('free');

    const res = await fetch(`${baseUrl}/subscriptions/tier`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data.tier).toBe('free');
  });
});

describe('POST /subscriptions/checkout', () => {
  it('returns checkout URL for org owner', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockCreateCheckoutSession.mockResolvedValueOnce({
      checkoutUrl: 'https://checkout.stripe.com/session/cs_test',
    });

    const res = await fetch(`${baseUrl}/subscriptions/checkout`, {
      method: 'POST',
      headers: authHeaders,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data.checkoutUrl).toBe('https://checkout.stripe.com/session/cs_test');
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(10, 1, expect.anything());
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/subscriptions/checkout`, {
      method: 'POST',
    });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-owner members', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());

    const res = await fetch(`${baseUrl}/subscriptions/checkout`, {
      method: 'POST',
      headers: authHeaders,
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /subscriptions/portal', () => {
  it('returns portal URL for owner with active subscription', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetSubscriptionByOrgId.mockResolvedValueOnce({ stripeCustomerId: 'cus_test' });
    mockCreatePortalSession.mockResolvedValueOnce({
      portalUrl: 'https://billing.stripe.com/session/bps_test',
    });

    const res = await fetch(`${baseUrl}/subscriptions/portal`, {
      method: 'POST',
      headers: authHeaders,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data.portalUrl).toBe('https://billing.stripe.com/session/bps_test');
  });

  it('returns 404 when no subscription exists', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetSubscriptionByOrgId.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/subscriptions/portal`, {
      method: 'POST',
      headers: authHeaders,
    });

    expect(res.status).toBe(404);
  });

  it('returns 403 for non-owner members', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());

    const res = await fetch(`${baseUrl}/subscriptions/portal`, {
      method: 'POST',
      headers: authHeaders,
    });

    expect(res.status).toBe(403);
  });
});
