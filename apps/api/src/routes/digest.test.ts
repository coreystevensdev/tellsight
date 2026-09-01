import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetByUserId = vi.fn();
const mockWithUserRlsContext = vi.fn(
  async (_userId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({}),
);

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  digestPreferencesQueries: {
    getByUserId: mockGetByUserId,
  },
}));

vi.mock('../lib/rls.js', () => ({
  withUserRlsContext: mockWithUserRlsContext,
}));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', APP_URL: 'http://localhost:3000' },
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
const { digestRouter } = await import('./digest.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/digest', digestRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function userPayload(overrides: Partial<{ sub: string; isAdmin: boolean }> = {}) {
  return {
    sub: '7',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

const authHeaders = { Cookie: 'access_token=valid-jwt' };

describe('GET /digest/last-sent (AC #8)', () => {
  it('returns the ISO timestamp when the user has a digest_preferences row with lastSentAt', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetByUserId.mockResolvedValueOnce({
      userId: 7,
      cadence: 'weekly',
      timezone: 'UTC',
      lastSentAt: new Date('2026-05-04T18:00:00Z'),
      unsubscribedAt: null,
    });

    const res = await fetch(`${baseUrl}/digest/last-sent`, { headers: authHeaders });
    const json = (await res.json()) as { data: { lastSentAt: string | null } };

    expect(res.status).toBe(200);
    expect(json.data.lastSentAt).toBe('2026-05-04T18:00:00.000Z');
  });

  it('returns null when the user has no digest_preferences row', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetByUserId.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/digest/last-sent`, { headers: authHeaders });
    const json = (await res.json()) as { data: { lastSentAt: string | null } };

    expect(res.status).toBe(200);
    expect(json.data.lastSentAt).toBeNull();
  });

  it('returns null when the row exists but lastSentAt is null', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetByUserId.mockResolvedValueOnce({
      userId: 7,
      cadence: 'weekly',
      timezone: 'UTC',
      lastSentAt: null,
      unsubscribedAt: null,
    });

    const res = await fetch(`${baseUrl}/digest/last-sent`, { headers: authHeaders });
    const json = (await res.json()) as { data: { lastSentAt: string | null } };

    expect(json.data.lastSentAt).toBeNull();
  });

  it('scopes the query through withUserRlsContext using the JWT user id', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ sub: '42' }));
    mockGetByUserId.mockResolvedValueOnce(undefined);

    await fetch(`${baseUrl}/digest/last-sent`, { headers: authHeaders });

    expect(mockWithUserRlsContext).toHaveBeenCalledTimes(1);
    const [userId, isAdmin] = mockWithUserRlsContext.mock.calls[0]!;
    expect(userId).toBe(42);
    expect(isAdmin).toBe(false);
    // Inner closure: getByUserId called with the same userId
    expect(mockGetByUserId).toHaveBeenCalledWith(42, expect.anything());
  });

  it('rejects a request with no access token, without consulting the verifier', async () => {
    const res = await fetch(`${baseUrl}/digest/last-sent`);

    expect(res.status).toBe(401);
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a request whose access token fails verification', async () => {
    // Has to be AuthenticationError, which is what the real verifier throws.
    // A bare Error reaches the handler as an unknown failure and returns 500.
    const { AuthenticationError } = await import('../lib/appError.js');
    mockVerifyAccessToken.mockRejectedValueOnce(new AuthenticationError('expired'));

    const res = await fetch(`${baseUrl}/digest/last-sent`, { headers: authHeaders });

    expect(res.status).toBe(401);
    expect(mockVerifyAccessToken).toHaveBeenCalledTimes(1);
  });
});
