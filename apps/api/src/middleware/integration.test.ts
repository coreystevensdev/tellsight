import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { Response } from 'express';
import { requireUser } from '../lib/requireUser.js';

const mockVerifyAccessToken = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
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
const { roleGuard } = await import('./roleGuard.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    // full middleware chain: authMiddleware → roleGuard → handler
    app.get(
      '/admin/users',
      authMiddleware,
      roleGuard('admin'),
      (req, res: Response) => {
        const user = requireUser(req);
        res.json({
          data: {
            userId: parseInt(user.sub, 10),
            orgId: user.org_id,
            role: user.role,
            isAdmin: user.isAdmin,
          },
        });
      },
    );
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());

describe('auth + roleGuard integration', () => {
  it('authenticated admin gets through the full chain', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '1',
      org_id: 10,
      role: 'owner',
      isAdmin: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const res = await fetch(`${baseUrl}/admin/users`, {
      headers: { Cookie: 'access_token=admin-jwt' },
    });
    const body = (await res.json()) as { data: { userId: number; isAdmin: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.userId).toBe(1);
    expect(body.data.isAdmin).toBe(true);
  });

  it('unauthenticated request is rejected at authMiddleware (401)', async () => {
    const res = await fetch(`${baseUrl}/admin/users`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('authenticated non-admin is rejected at roleGuard (403)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '2',
      org_id: 10,
      role: 'member',
      isAdmin: false,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const res = await fetch(`${baseUrl}/admin/users`, {
      headers: { Cookie: 'access_token=member-jwt' },
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('response includes correct correlation-id header', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '1',
      org_id: 10,
      role: 'owner',
      isAdmin: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });

    const res = await fetch(`${baseUrl}/admin/users`, {
      headers: { Cookie: 'access_token=admin-jwt' },
    });

    const corrId = res.headers.get('x-correlation-id');
    expect(corrId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i);
  });
});
