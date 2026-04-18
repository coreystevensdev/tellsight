import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextFunction, Request, Response, Router } from 'express';

interface MockCookieOpts {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  maxAge?: number;
  path?: string;
}

interface MockReq {
  user: { sub: string; org_id: number; role: string; isAdmin: boolean };
  cookies: Record<string, string>;
  query: Record<string, string | undefined>;
  [key: string]: unknown;
}

interface JsonBody {
  data?: Record<string, unknown>;
  error?: { code: string; message?: string; details?: unknown };
}

interface MockRes {
  statusCode: number;
  _json: JsonBody | null;
  _redirectUrl: string | null;
  _cookies: Record<string, { value: string; opts: MockCookieOpts }>;
  _clearedCookies: string[];
  status(code: number): MockRes;
  json(data: JsonBody): MockRes;
  redirect(url: string): MockRes;
  cookie(name: string, value: string, opts: MockCookieOpts): MockRes;
  clearCookie(name: string, opts?: MockCookieOpts): MockRes;
}

class RoleGuardError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

const mockGetByOrgAndProvider = vi.fn();
const mockUpsert = vi.fn();
const mockDeleteByOrgAndProvider = vi.fn();
const mockGenerateAuthUrl = vi.fn();
const mockExchangeCode = vi.fn();
const mockRevokeToken = vi.fn();
const mockEncrypt = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../config.js', () => ({
  env: {
    APP_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
    QUICKBOOKS_CLIENT_ID: 'test-client-id',
    QUICKBOOKS_CLIENT_SECRET: 'test-secret',
    QUICKBOOKS_REDIRECT_URI: 'http://localhost:3001/integrations/quickbooks/callback',
    ENCRYPTION_KEY: 'a'.repeat(64),
  },
  isQbConfigured: () => true,
}));

vi.mock('../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByOrgAndProvider: mockGetByOrgAndProvider,
    upsert: mockUpsert,
    deleteByOrgAndProvider: mockDeleteByOrgAndProvider,
  },
}));

vi.mock('../services/integrations/quickbooks/oauth.js', () => ({
  generateAuthUrl: mockGenerateAuthUrl,
  exchangeCode: mockExchangeCode,
  revokeToken: mockRevokeToken,
}));

vi.mock('../services/integrations/encryption.js', () => ({
  encrypt: mockEncrypt,
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../services/audit/auditService.js', () => ({
  audit: vi.fn(),
  auditAuth: vi.fn(),
}));

vi.mock('../services/integrations/worker.js', () => ({
  enqueueSyncJob: vi.fn(),
}));

vi.mock('../services/integrations/scheduler.js', () => ({
  registerDailySync: vi.fn(),
  removeDailySync: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../middleware/roleGuard.js', () => ({
  roleGuard: (role: string) => (req: MockReq, _res: MockRes, next: NextFunction) => {
    if (role === 'owner' && req.user?.role !== 'owner') {
      throw new RoleGuardError('Owner access required', 403, 'FORBIDDEN');
    }
    next();
  },
}));

// Lightweight Express test helper
function createMockReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    user: { sub: '1', org_id: 10, role: 'owner', isAdmin: false },
    cookies: {},
    query: {},
    ...overrides,
  };
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    _json: null,
    _redirectUrl: null,
    _cookies: {},
    _clearedCookies: [],
    status(code: number) { res.statusCode = code; return res; },
    json(data: JsonBody) { res._json = data; return res; },
    redirect(url: string) { res._redirectUrl = url; return res; },
    cookie(name: string, value: string, opts: MockCookieOpts) { res._cookies[name] = { value, opts }; return res; },
    clearCookie(name: string) { res._clearedCookies.push(name); return res; },
  };
  return res;
}

describe('integrations routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /quickbooks/connect', () => {
    it('returns auth URL and sets state cookie', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce(null);
      mockGenerateAuthUrl.mockReturnValueOnce({
        authUrl: 'https://appcenter.intuit.com/connect/oauth2?foo=bar',
        state: 'random-state-123',
      });

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'POST', '/quickbooks/connect');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._json).toEqual({
        data: { authUrl: 'https://appcenter.intuit.com/connect/oauth2?foo=bar' },
      });
      expect(res._cookies.qb_oauth_state).toBeDefined();
      expect(res._cookies.qb_oauth_state?.value).toBe('random-state-123');
      expect(res._cookies.qb_oauth_state?.opts.httpOnly).toBe(true);
      expect(res._cookies.qb_oauth_org_id).toBeDefined();
      expect(res._cookies.qb_oauth_user_id).toBeDefined();
    });

    it('returns 409 if already connected', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce({ id: 1 });

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'POST', '/quickbooks/connect');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res.statusCode).toBe(409);
      expect(res._json?.error?.code).toBe('ALREADY_CONNECTED');
    });
  });

  describe('GET /quickbooks/status', () => {
    it('returns connected status when connection exists', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce({
        id: 1,
        providerTenantId: 'realm123',
        syncStatus: 'idle',
        lastSyncedAt: new Date('2026-04-15T03:00:00Z'),
        syncError: null,
        createdAt: new Date('2026-04-10T14:00:00Z'),
      });

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'GET', '/quickbooks/status');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._json?.data?.connected).toBe(true);
      expect(res._json?.data?.provider).toBe('quickbooks');
      expect(res._json?.data?.syncStatus).toBe('idle');
    });

    it('returns disconnected when no connection', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce(null);

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'GET', '/quickbooks/status');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._json?.data?.connected).toBe(false);
    });
  });

  describe('POST /quickbooks/sync', () => {
    it('returns 409 if sync already in progress', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce({ id: 1, syncStatus: 'syncing' });

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'POST', '/quickbooks/sync');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res.statusCode).toBe(409);
      expect(res._json?.error?.code).toBe('SYNC_IN_PROGRESS');
    });

    it('returns 404 if not connected', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce(null);

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'POST', '/quickbooks/sync');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /quickbooks', () => {
    it('disconnects and fires analytics event', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce({
        id: 1,
        encryptedRefreshToken: 'enc-token',
      });
      mockDeleteByOrgAndProvider.mockResolvedValueOnce(1);
      mockRevokeToken.mockResolvedValueOnce(undefined);

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'DELETE', '/quickbooks');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(mockRevokeToken).toHaveBeenCalledWith('enc-token');
      expect(mockDeleteByOrgAndProvider).toHaveBeenCalledWith(10, 'quickbooks');
      expect(mockTrackEvent).toHaveBeenCalledWith(
        10, 1, 'integration.disconnected',
        expect.objectContaining({ provider: 'quickbooks' }),
      );
      expect(res._json?.data?.message).toBe('QuickBooks disconnected');
    });

    it('returns 404 if not connected', async () => {
      mockGetByOrgAndProvider.mockResolvedValueOnce(null);

      const { integrationsRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsRouter, 'DELETE', '/quickbooks');

      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /quickbooks/callback', () => {
    it('exchanges code and creates connection on valid callback', async () => {
      mockExchangeCode.mockResolvedValueOnce({
        accessToken: 'access-123',
        refreshToken: 'refresh-456',
        expiresIn: 3600,
        realmId: 'realm789',
      });
      mockEncrypt.mockReturnValueOnce('enc-access').mockReturnValueOnce('enc-refresh');
      mockUpsert.mockResolvedValueOnce({ id: 1 });

      const { integrationsCallbackRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsCallbackRouter, 'GET', '/quickbooks/callback');

      const req = createMockReq({
        query: { code: 'auth-code', realmId: 'realm789', state: 'valid-state' },
        cookies: {
          qb_oauth_state: 'valid-state',
          qb_oauth_org_id: '10',
          qb_oauth_user_id: '1',
        },
      });
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._redirectUrl).toBe('http://localhost:3000/dashboard?qb=connected');
      expect(mockExchangeCode).toHaveBeenCalledWith('auth-code', 'realm789');
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 10,
          provider: 'quickbooks',
          providerTenantId: 'realm789',
        }),
      );
      expect(mockTrackEvent).toHaveBeenCalled();
    });

    it('redirects with error on state mismatch', async () => {
      const { integrationsCallbackRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsCallbackRouter, 'GET', '/quickbooks/callback');

      const req = createMockReq({
        query: { code: 'auth-code', realmId: 'realm789', state: 'wrong-state' },
        cookies: { qb_oauth_state: 'correct-state' },
      });
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._redirectUrl).toBe('http://localhost:3000/dashboard?qb=error');
      expect(mockExchangeCode).not.toHaveBeenCalled();
    });

    it('redirects with denied on user cancel', async () => {
      const { integrationsCallbackRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsCallbackRouter, 'GET', '/quickbooks/callback');

      const req = createMockReq({
        query: { error: 'access_denied' },
      });
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._redirectUrl).toBe('http://localhost:3000/dashboard?qb=denied');
    });

    it('redirects with error when missing state cookie', async () => {
      const { integrationsCallbackRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsCallbackRouter, 'GET', '/quickbooks/callback');

      const req = createMockReq({
        query: { code: 'auth-code', realmId: 'realm789', state: 'some-state' },
        cookies: {},
      });
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._redirectUrl).toBe('http://localhost:3000/dashboard?qb=error');
    });

    it('redirects with error on token exchange failure', async () => {
      mockExchangeCode.mockRejectedValueOnce(new Error('Token exchange failed'));

      const { integrationsCallbackRouter } = await import('./integrations.js');
      const handler = getRouteHandler(integrationsCallbackRouter, 'GET', '/quickbooks/callback');

      const req = createMockReq({
        query: { code: 'bad-code', realmId: 'realm789', state: 'valid-state' },
        cookies: {
          qb_oauth_state: 'valid-state',
          qb_oauth_org_id: '10',
          qb_oauth_user_id: '1',
        },
      });
      const res = createMockRes();
      await handler(req, res, vi.fn());

      expect(res._redirectUrl).toBe('http://localhost:3000/dashboard?qb=error');
    });
  });
});

// Run the full middleware + handler chain for a route.
// Each middleware must fully complete before we advance — we wait on the
// current promise and only advance when done, since Express middleware
// typically call next() without awaiting it themselves.
interface RouteLayer {
  method?: string;
  handle: (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
}

interface RouterStack {
  stack: Array<{ route?: { path: string; stack: RouteLayer[] } }>;
}

function getRouteHandler(router: Router, method: string, path: string) {
  const methodLower = method.toLowerCase();
  for (const layer of (router as unknown as RouterStack).stack) {
    if (layer.route?.path === path) {
      const stack = layer.route.stack.filter(
        (l) => l.method === methodLower || !l.method,
      );

      return async (req: MockReq, res: MockRes, finalNext?: NextFunction) => {
        for (const routeLayer of stack) {
          let advanced = false;
          let nextErr: unknown = null;
          const nextCalled = new Promise<void>((resolve) => {
            const nx: NextFunction = (err?: unknown) => {
              advanced = true;
              nextErr = err;
              resolve();
            };
            Promise.resolve(
              routeLayer.handle(req as unknown as Request, res as unknown as Response, nx),
            ).then(() => resolve());
          });
          await nextCalled;
          if (nextErr) throw nextErr;
          if (!advanced) return; // route handler ended without calling next (sent response)
        }
        finalNext?.();
      };
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}
