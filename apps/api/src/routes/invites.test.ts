import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGenerateInvite = vi.fn();
const mockValidateInviteToken = vi.fn();
const mockGetActiveInvitesForOrg = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../services/auth/inviteService.js', () => ({
  generateInvite: mockGenerateInvite,
  validateInviteToken: mockValidateInviteToken,
  getActiveInvitesForOrg: mockGetActiveInvitesForOrg,
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3000',
  },
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
const { inviteRouter, publicInviteRouter } = await import('./invites.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    // public route, no auth
    app.use(publicInviteRouter);

    // protected route, auth required
    app.use(authMiddleware);
    app.use('/invites', inviteRouter);
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

describe('GET /invites', () => {
  it('owner gets list of active invites', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetActiveInvitesForOrg.mockResolvedValueOnce([
      { id: 1, orgId: 10, expiresAt: new Date('2026-03-04T00:00:00Z'), createdBy: 1 },
      { id: 2, orgId: 10, expiresAt: new Date('2026-03-10T00:00:00Z'), createdBy: 1 },
    ]);

    const res = await fetch(`${baseUrl}/invites`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });

    const body = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(mockGetActiveInvitesForOrg).toHaveBeenCalledWith(10, expect.anything());
  });

  it('member gets 403, only owners can list invites', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());

    const res = await fetch(`${baseUrl}/invites`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });

    expect(res.status).toBe(403);
  });
});

describe('POST /invites', () => {
  it('owner creates an invite and gets URL back', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGenerateInvite.mockResolvedValueOnce({
      token: 'abc123',
      expiresAt: new Date('2026-03-04T00:00:00Z'),
    });

    const res = await fetch(`${baseUrl}/invites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as {
      data: { url: string; token: string; expiresAt: string };
    };

    expect(res.status).toBe(201);
    expect(body.data.url).toBe('http://localhost:3000/invite/abc123');
    expect(body.data.token).toBe('abc123');
    expect(body.data.expiresAt).toBeDefined();
  });

  it('owner passes custom expiry days', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGenerateInvite.mockResolvedValueOnce({
      token: 'def456',
      expiresAt: new Date('2026-03-14T00:00:00Z'),
    });

    const res = await fetch(`${baseUrl}/invites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ expiresInDays: 14 }),
    });

    expect(res.status).toBe(201);
    expect(mockGenerateInvite).toHaveBeenCalledWith(10, 1, 14, expect.anything());
  });

  it('member gets 403, only owners can create invites', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(memberPayload());

    const res = await fetch(`${baseUrl}/invites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('unauthenticated request gets 401', async () => {
    const res = await fetch(`${baseUrl}/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(401);
  });

  it('invalid body gets 400', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/invites`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ expiresInDays: 999 }),
    });

    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /invites/:token', () => {
  it('valid token returns org info', async () => {
    mockValidateInviteToken.mockResolvedValueOnce({
      id: 1,
      orgId: 10,
      expiresAt: new Date('2026-03-04T00:00:00Z'),
      org: { id: 10, name: 'Acme Inc' },
    });

    const res = await fetch(`${baseUrl}/invites/some-token-here`);
    const body = (await res.json()) as {
      data: { orgName: string; expiresAt: string };
    };

    expect(res.status).toBe(200);
    expect(body.data.orgName).toBe('Acme Inc');
    expect(body.data.expiresAt).toBeDefined();
  });

  it('expired token returns error', async () => {
    const { ValidationError } = await import('../lib/appError.js');
    mockValidateInviteToken.mockRejectedValueOnce(
      new ValidationError('This invite link has expired, ask the org owner for a new one'),
    );

    const res = await fetch(`${baseUrl}/invites/expired-token`);
    const body = (await res.json()) as { error: { message: string } };

    expect(res.status).toBe(400);
    expect(body.error.message).toContain('expired');
  });

  it('nonexistent token returns 404', async () => {
    const { NotFoundError } = await import('../lib/appError.js');
    mockValidateInviteToken.mockRejectedValueOnce(
      new NotFoundError('Invite not found'),
    );

    const res = await fetch(`${baseUrl}/invites/bad-token`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
