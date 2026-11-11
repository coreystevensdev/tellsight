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
const { roleGuard } = await import('./roleGuard.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);

    app.get('/owner-only', roleGuard('owner'), (_req: Request, res: Response) => {
      res.json({ data: { access: 'owner' } });
    });

    app.get('/admin-only', roleGuard('admin'), (_req: Request, res: Response) => {
      res.json({ data: { access: 'admin' } });
    });

    app.get('/member-ok', roleGuard('member'), (_req: Request, res: Response) => {
      res.json({ data: { access: 'member' } });
    });
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function makePayload(overrides: Partial<{ role: string; isAdmin: boolean }> = {}) {
  return {
    sub: '42',
    org_id: 10,
    role: overrides.role ?? 'member',
    isAdmin: overrides.isAdmin ?? false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const headers = { Cookie: 'access_token=valid-jwt' };

describe('roleGuard', () => {
  it('owner passes owner check', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ role: 'owner' }));

    const res = await fetch(`${baseUrl}/owner-only`, { headers });
    expect(res.status).toBe(200);
  });

  it('member fails owner check with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/owner-only`, { headers });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('platform admin passes admin check', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ isAdmin: true }));

    const res = await fetch(`${baseUrl}/admin-only`, { headers });
    expect(res.status).toBe(200);
  });

  it('non-admin fails admin check with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ isAdmin: false }));

    const res = await fetch(`${baseUrl}/admin-only`, { headers });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('member passes member check', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/member-ok`, { headers });
    expect(res.status).toBe(200);
  });

  it('owner also passes member check', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(makePayload({ role: 'owner' }));

    const res = await fetch(`${baseUrl}/member-ok`, { headers });
    expect(res.status).toBe(200);
  });
});
