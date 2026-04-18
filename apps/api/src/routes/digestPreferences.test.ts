import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetDigestOptIn = vi.fn();
const mockUpdateDigestOptIn = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  userOrgsQueries: {
    getDigestOptIn: mockGetDigestOptIn,
    updateDigestOptIn: mockUpdateDigestOptIn,
  },
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
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
const { digestPreferencesRouter } = await import('./digestPreferences.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/preferences', digestPreferencesRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function userPayload() {
  return {
    sub: '5',
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

describe('GET /preferences/digest', () => {
  it('returns current opt-in status', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetDigestOptIn.mockResolvedValueOnce(true);

    const res = await fetch(`${baseUrl}/preferences/digest`, { headers: authHeaders });
    const json = (await res.json()) as { data: { digestOptIn: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.digestOptIn).toBe(true);
    expect(mockGetDigestOptIn).toHaveBeenCalledWith(10, 5);
  });

  it('returns false when user opted out', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetDigestOptIn.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/preferences/digest`, { headers: authHeaders });
    const json = (await res.json()) as { data: { digestOptIn: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.digestOptIn).toBe(false);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/preferences/digest`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /preferences/digest', () => {
  it('updates opt-in to false', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockUpdateDigestOptIn.mockResolvedValueOnce({ digestOptIn: false });

    const res = await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ digestOptIn: false }),
    });
    const json = (await res.json()) as { data: { digestOptIn: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.digestOptIn).toBe(false);
    expect(mockUpdateDigestOptIn).toHaveBeenCalledWith(10, 5, false);
  });

  it('updates opt-in to true', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockUpdateDigestOptIn.mockResolvedValueOnce({ digestOptIn: true });

    const res = await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ digestOptIn: true }),
    });
    const json = (await res.json()) as { data: { digestOptIn: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.digestOptIn).toBe(true);
  });

  it('fires analytics event on change', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockUpdateDigestOptIn.mockResolvedValueOnce({ digestOptIn: false });

    await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ digestOptIn: false }),
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      5,
      'digest.preference_changed',
      { digestOptIn: false },
    );
  });

  it('rejects non-boolean values', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ digestOptIn: 'yes' }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateDigestOptIn).not.toHaveBeenCalled();
  });

  it('rejects missing body', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/preferences/digest`, {
      method: 'PATCH',
      body: JSON.stringify({ digestOptIn: false }),
    });
    expect(res.status).toBe(401);
  });
});
