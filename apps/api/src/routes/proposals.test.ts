import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetPendingProposals = vi.fn();
const mockResolveProposal = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/agentProposals.js', () => ({
  getPendingProposals: mockGetPendingProposals,
  resolveProposal: mockResolveProposal,
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
const { proposalsRouter } = await import('./proposals.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/proposals', proposalsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());

function userPayload() {
  return {
    sub: '7',
    org_id: 3,
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

describe('GET /proposals', () => {
  it('returns pending proposals for the org', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetPendingProposals.mockResolvedValueOnce([
      { id: 1, orgId: 3, kind: 'anomaly', status: 'pending' },
      { id: 2, orgId: 3, kind: 'trend', status: 'pending' },
    ]);

    const res = await fetch(`${baseUrl}/proposals`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(2);
    expect(mockGetPendingProposals).toHaveBeenCalledWith(3);
  });

  it('returns 401 without auth cookie', async () => {
    const res = await fetch(`${baseUrl}/proposals`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /proposals/:id', () => {
  it('approves a pending proposal', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockResolveProposal.mockResolvedValueOnce({ id: 5, orgId: 3 });

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { id: number };
    expect(body.id).toBe(5);
    expect(mockResolveProposal).toHaveBeenCalledWith(5, 'approved', 7, 3);
  });

  it('returns 404 when proposal is not found or already resolved', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockResolveProposal.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/proposals/99`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid status value', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'pending' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for non-numeric proposal id', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());

    const res = await fetch(`${baseUrl}/proposals/abc`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });

    expect(res.status).toBe(400);
  });
});
