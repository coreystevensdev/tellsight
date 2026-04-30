import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGenerateShareLink = vi.fn();
const mockGetSharedInsight = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../services/sharing/index.js', () => ({
  generateShareLink: mockGenerateShareLink,
  getSharedInsight: mockGetSharedInsight,
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
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
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { shareRouter, publicShareRouter } = await import('./sharing.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    // public, no auth
    app.use(publicShareRouter);

    // protected, auth required
    app.use(authMiddleware);
    app.use('/shares', shareRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function memberPayload() {
  return {
    sub: '1',
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

describe('POST /shares', () => {
  it('creates a share and returns 201 with url and token', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());
    mockGenerateShareLink.mockResolvedValueOnce({
      token: 'abc'.repeat(21) + 'a', // 64 chars
      url: 'http://localhost:3000/share/abc',
      expiresAt: new Date('2026-04-24T00:00:00Z'),
    });

    const res = await fetch(`${baseUrl}/shares`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 5 }),
    });

    const body = (await res.json()) as {
      data: { url: string; token: string; expiresAt: string };
    };

    expect(res.status).toBe(201);
    expect(body.data.url).toContain('/share/');
    expect(body.data.token).toBeDefined();
    expect(mockGenerateShareLink).toHaveBeenCalledWith(10, 5, 1, expect.anything());
  });

  it('does not fire share.created server-side (moved to client useCreateShareLink)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());
    mockGenerateShareLink.mockResolvedValueOnce({
      token: 'x'.repeat(64),
      url: 'http://localhost:3000/share/x',
      expiresAt: new Date(),
    });

    await fetch(`${baseUrl}/shares`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ datasetId: 7 }),
    });

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for missing datasetId', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());

    const res = await fetch(`${baseUrl}/shares`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/shares`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datasetId: 5 }),
    });

    expect(res.status).toBe(401);
  });
});

describe('GET /shares/:token', () => {
  it('returns insight data for a valid token', async () => {
    mockGetSharedInsight.mockResolvedValueOnce({
      orgName: 'Sunrise Cafe',
      dateRange: 'Jan, Feb 2026',
      aiSummaryContent: 'Revenue grew 12%.',
      chartConfig: { type: 'bar' },
      viewCount: 4,
    });

    const res = await fetch(`${baseUrl}/shares/${'a'.repeat(64)}`);
    const body = (await res.json()) as {
      data: { orgName: string; viewCount: number };
    };

    expect(res.status).toBe(200);
    expect(body.data.orgName).toBe('Sunrise Cafe');
    expect(body.data.viewCount).toBe(4);
  });

  it('returns 404 for unknown token', async () => {
    const { NotFoundError } = await import('../lib/appError.js');
    mockGetSharedInsight.mockRejectedValueOnce(new NotFoundError('Share not found'));

    const res = await fetch(`${baseUrl}/shares/${'b'.repeat(64)}`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 410 for expired share', async () => {
    const { AppError } = await import('../lib/appError.js');
    mockGetSharedInsight.mockRejectedValueOnce(
      new AppError('This share link has expired', 'GONE', 410),
    );

    const res = await fetch(`${baseUrl}/shares/${'c'.repeat(64)}`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(410);
    expect(body.error.code).toBe('GONE');
  });

  it('returns 400 for a too-short token', async () => {
    const res = await fetch(`${baseUrl}/shares/short`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
