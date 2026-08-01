import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetPendingProposals = vi.fn();
const mockResolveProposal = vi.fn();
const mockAudit = vi.fn();
const mockGetAgentEnabled = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/agentProposals.js', () => ({
  getPendingProposals: mockGetPendingProposals,
  resolveProposal: mockResolveProposal,
}));

vi.mock('../db/queries/index.js', () => ({
  subscriptionsQueries: {
    getAgentEnabled: (...args: unknown[]) => mockGetAgentEnabled(...args),
  },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../services/audit/auditService.js', () => ({
  audit: mockAudit,
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
const { proposalsRouter } = await import('./proposals.js');
const { withRlsContext } = await import('../lib/rls.js');

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
beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgentEnabled.mockResolvedValue(true);
});

function userPayload(overrides: Partial<{ role: string; org_id: number }> = {}) {
  return {
    sub: '7',
    org_id: 3,
    role: 'owner',
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

describe('GET /proposals', () => {
  it('returns pending proposals for the org', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ role: 'member' }));
    mockGetPendingProposals.mockResolvedValueOnce([
      { id: 1, orgId: 3, kind: 'anomaly', status: 'pending' },
      { id: 2, orgId: 3, kind: 'trend', status: 'pending' },
    ]);

    const res = await fetch(`${baseUrl}/proposals`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(2);
    expect(mockGetPendingProposals).toHaveBeenCalledWith(3, expect.anything());
  });

  it('returns 401 without auth cookie', async () => {
    const res = await fetch(`${baseUrl}/proposals`);
    expect(res.status).toBe(401);
  });

  it('returns 403 AGENT_TIER_REQUIRED without entitlement, no proposals read', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ role: 'member' }));
    mockGetAgentEnabled.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/proposals`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('AGENT_TIER_REQUIRED');
    expect(mockGetPendingProposals).not.toHaveBeenCalled();
  });

  it('fails closed with 403 (not 500) when the entitlement lookup itself throws', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ role: 'member' }));
    vi.mocked(withRlsContext).mockImplementationOnce(() => {
      throw new Error('SET LOCAL failed');
    });

    const res = await fetch(`${baseUrl}/proposals`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('AGENT_TIER_REQUIRED');
    expect(mockGetPendingProposals).not.toHaveBeenCalled();
  });
});

describe('PATCH /proposals/:id', () => {
  it('approves a pending proposal as owner and writes an audit row', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockResolveProposal.mockResolvedValueOnce({ id: 5, orgId: 3 });

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });
    const json = (await res.json()) as { data: { id: number } };

    expect(res.status).toBe(200);
    expect(json.data.id).toBe(5);
    expect(mockResolveProposal).toHaveBeenCalledWith(5, 'approved', 7, 3, expect.anything());
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 3,
        userId: 7,
        action: 'proposal.approved',
        targetType: 'agent_proposal',
        targetId: '5',
      }),
    );
  });

  it('rejects a pending proposal as owner and writes an audit row', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockResolveProposal.mockResolvedValueOnce({ id: 5, orgId: 3 });

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'proposal.rejected' }),
    );
  });

  it('rejects a non-owner org member with 403 before the handler body runs', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });

    expect(res.status).toBe(403);
    expect(mockResolveProposal).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('rejects a non-owner member lacking entitlement with the role error, not AGENT_TIER_REQUIRED -- roleGuard runs first', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload({ role: 'member' }));
    // Deliberately not stubbing mockGetAgentEnabled to false here: roleGuard
    // must reject before the handler ever calls it, so the beforeEach default
    // (true) proves nothing about this path -- the assertion below is the
    // actual proof getAgentEnabled was never reached.

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('FORBIDDEN');
    expect(mockGetAgentEnabled).not.toHaveBeenCalled();
    expect(mockResolveProposal).not.toHaveBeenCalled();
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
    expect(mockAudit).not.toHaveBeenCalled();
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

  it('returns 401 without auth cookie', async () => {
    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 AGENT_TIER_REQUIRED for an owner without entitlement, before the resolve call', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(userPayload());
    mockGetAgentEnabled.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/proposals/5`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(json.error.code).toBe('AGENT_TIER_REQUIRED');
    expect(mockResolveProposal).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
