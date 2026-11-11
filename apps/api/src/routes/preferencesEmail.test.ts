import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetByUserId = vi.fn();
const mockSetCadence = vi.fn();
const mockSetTimezone = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokens.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  digestPreferencesQueries: {
    getByUserId: mockGetByUserId,
    setCadence: mockSetCadence,
    setTimezone: mockSetTimezone,
  },
}));

vi.mock('../lib/rls.js', () => ({
  withUserRlsContext: vi.fn((_userId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
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
const { preferencesEmailRouter } = await import('./preferencesEmail.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/preferences/email', preferencesEmailRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function userPayload() {
  return {
    sub: '7',
    org_id: 10,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

describe('GET /preferences/email/digest', () => {
  it('returns the existing preferences row when one exists', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetByUserId.mockResolvedValueOnce({
      userId: 7,
      cadence: 'monthly',
      timezone: 'America/Los_Angeles',
      lastSentAt: new Date('2026-05-04T18:00:00Z'),
      unsubscribedAt: null,
    });

    const res = await fetch(`${baseUrl}/preferences/email/digest`, { headers: authHeaders });
    const json = (await res.json()) as { data: { cadence: string; timezone: string; lastSentAt: string | null; unsubscribedAt: string | null } };

    expect(res.status).toBe(200);
    expect(json.data.cadence).toBe('monthly');
    expect(json.data.timezone).toBe('America/Los_Angeles');
    expect(json.data.lastSentAt).toBe('2026-05-04T18:00:00.000Z');
    expect(json.data.unsubscribedAt).toBeNull();
  });

  it('returns defaults without auto-creating when no row exists', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetByUserId.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/preferences/email/digest`, { headers: authHeaders });
    const json = (await res.json()) as { data: { cadence: string; timezone: string } };

    expect(res.status).toBe(200);
    expect(json.data.cadence).toBe('weekly');
    expect(json.data.timezone).toBe('UTC');
    expect(mockSetCadence).not.toHaveBeenCalled();
    expect(mockSetTimezone).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/preferences/email/digest`);
    expect(res.status).toBe(401);
  });
});

describe('PUT /preferences/email/digest', () => {
  it('persists cadence + timezone and emits the analytics event on success', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockSetCadence.mockResolvedValueOnce(undefined);
    mockSetTimezone.mockResolvedValueOnce(undefined);

    const res = await fetch(`${baseUrl}/preferences/email/digest`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cadence: 'monthly', timezone: 'America/Los_Angeles' }),
    });
    const json = (await res.json()) as { data: { cadence: string; timezone: string } };

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ cadence: 'monthly', timezone: 'America/Los_Angeles' });
    expect(mockSetCadence).toHaveBeenCalledWith(7, 'monthly', expect.anything());
    expect(mockSetTimezone).toHaveBeenCalledWith(7, 'America/Los_Angeles', expect.anything());
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 7, 'digest.preference_changed', {
      cadence: 'monthly',
      timezone: 'America/Los_Angeles',
    });
  });

  it('rejects an invalid cadence value', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/preferences/email/digest`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cadence: 'daily', timezone: 'UTC' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockSetCadence).not.toHaveBeenCalled();
  });

  it('rejects unknown keys via the strict schema', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/preferences/email/digest`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cadence: 'weekly', timezone: 'UTC', unsubscribedAt: '2026-05-01' }),
    });

    expect(res.status).toBe(400);
    expect(mockSetCadence).not.toHaveBeenCalled();
  });

  it('rejects an empty timezone string', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/preferences/email/digest`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cadence: 'weekly', timezone: '' }),
    });

    expect(res.status).toBe(400);
    expect(mockSetCadence).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`${baseUrl}/preferences/email/digest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cadence: 'weekly', timezone: 'UTC' }),
    });
    expect(res.status).toBe(401);
  });
});
