import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Request, Response } from 'express';

const mockVerifyAccessToken = vi.fn();

vi.mock('../services/auth/tokens.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test' },
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
const { authMiddleware } = await import('./authMiddleware.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.get('/protected', (req: Request, res: Response) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (req as any).user;
      res.json({ data: { userId: user.sub, role: user.role } });
    });
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

describe('authMiddleware', () => {
  const validPayload = {
    sub: '42',
    org_id: 10,
    role: 'owner' as const,
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };

  it('attaches parsed JWT claims to req.user on valid token', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(validPayload);

    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = (await res.json()) as { data: { userId: string; role: string } };

    expect(res.status).toBe(200);
    expect(body.data.userId).toBe('42');
    expect(body.data.role).toBe('owner');
    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid-jwt');
  });

  it('returns 401 when access_token cookie is missing', async () => {
    const res = await fetch(`${baseUrl}/protected`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it('returns 401 when token is expired', async () => {
    mockVerifyAccessToken.mockRejectedValueOnce(
      new (await import('../lib/appError.js')).AuthenticationError('Invalid or expired access token'),
    );

    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Cookie: 'access_token=expired-jwt' },
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns 401 when token is malformed', async () => {
    mockVerifyAccessToken.mockRejectedValueOnce(
      new (await import('../lib/appError.js')).AuthenticationError('Invalid or expired access token'),
    );

    const res = await fetch(`${baseUrl}/protected`, {
      headers: { Cookie: 'access_token=not.a.valid.jwt' },
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });
});
