import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetByOrgId = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockSoftDelete = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  alertRulesQueries: {
    getByOrgId: mockGetByOrgId,
    create: mockCreate,
    update: mockUpdate,
    softDelete: mockSoftDelete,
  },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

const mockRateLimitDashboardCompute = vi.fn((_req: unknown, _res: unknown, next: () => void) => next());
vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitDashboardCompute: (req: unknown, res: unknown, next: () => void) =>
    mockRateLimitDashboardCompute(req, res, next),
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
const { alertRulesRouter } = await import('./alertRules.js');
const { ConflictError } = await import('../lib/appError.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/org', alertRulesRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function ownerPayload(overrides: Partial<{ role: string; org_id: number }> = {}) {
  return {
    sub: '5',
    org_id: 10,
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

const mockRule = {
  id: 1,
  orgId: 10,
  createdByUserId: 5,
  kind: 'runway_runs_short',
  threshold: { months: 3 },
  enabled: true,
  muteUntil: null,
  deletedAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

describe('GET /org/alert-rules', () => {
  it('returns rules for any authenticated org member', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));
    mockGetByOrgId.mockResolvedValueOnce([mockRule]);

    const res = await fetch(`${baseUrl}/org/alert-rules`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
    expect(mockGetByOrgId).toHaveBeenCalledWith(10, expect.anything());
  });

  it('returns an empty array for an org with no rules', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetByOrgId.mockResolvedValueOnce([]);

    const res = await fetch(`${baseUrl}/org/alert-rules`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toEqual([]);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/org/alert-rules`);
    expect(res.status).toBe(401);
  });
});

describe('POST /org/alert-rules', () => {
  it('creates a rule as owner and fires the created analytics event', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockCreate.mockResolvedValueOnce(mockRule);

    const res = await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });
    const json = (await res.json()) as { data: { id: number } };

    expect(res.status).toBe(201);
    expect(json.data.id).toBe(1);
    expect(mockCreate).toHaveBeenCalledWith(10, 5, { kind: 'runway_runs_short', threshold: { months: 3 } }, expect.anything());
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'alert_rule.created', {
      ruleId: 1,
      ruleKind: 'runway_runs_short',
    });
  });

  it('rejects a threshold shape that does not match kind', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'margin_drops', threshold: { months: 3 } }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a non-owner org member with 403 before the handler body runs', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an unrecognized kind', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'made_up_kind', threshold: {} }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 409 when the org already has an active rule of that kind', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockCreate.mockRejectedValueOnce(new ConflictError('An active runway_runs_short alert rule already exists for this org'));

    const res = await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT');
  });

  it('routes through rateLimitDashboardCompute', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockCreate.mockResolvedValueOnce(mockRule);

    await fetch(`${baseUrl}/org/alert-rules`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(mockRateLimitDashboardCompute).toHaveBeenCalled();
  });
});

describe('PUT /org/alert-rules/:id', () => {
  it('updates a rule as owner and fires the updated analytics event', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockUpdate.mockResolvedValueOnce({ ...mockRule, kind: 'margin_drops', threshold: { percent: 10 } });

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'margin_drops', threshold: { percent: 10 } }),
    });
    const json = (await res.json()) as { data: { kind: string } };

    expect(res.status).toBe(200);
    expect(json.data.kind).toBe('margin_drops');
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'alert_rule.updated', {
      ruleId: 1,
      ruleKind: 'margin_drops',
    });
  });

  it('rejects a threshold shape that does not match the new kind', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'margin_drops', threshold: { months: 3 } }),
    });
    const json = (await res.json()) as { error: { code: string; details: unknown } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when the rule belongs to a different org, not a leak', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockUpdate.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/org/alert-rules/999`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(res.status).toBe(404);
  });

  it('rejects a non-owner org member with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric id param', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/alert-rules/not-a-number`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects an id with a numeric prefix and trailing garbage instead of truncating it', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/alert-rules/1abc`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'runway_runs_short', threshold: { months: 3 } }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('DELETE /org/alert-rules/:id', () => {
  it('soft-deletes a rule as owner and fires the deleted analytics event', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockSoftDelete.mockResolvedValueOnce({ ...mockRule, deletedAt: '2026-07-17T00:00:00.000Z' });

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    const json = (await res.json()) as { data: { deleted: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.deleted).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'alert_rule.deleted', {
      ruleId: 1,
      ruleKind: 'runway_runs_short',
    });
  });

  it('returns 404 when the rule is already deleted or missing', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockSoftDelete.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    expect(res.status).toBe(404);
  });

  it('rejects a non-owner org member with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/alert-rules/1`, {
      method: 'DELETE',
      headers: authHeaders,
    });

    expect(res.status).toBe(403);
    expect(mockSoftDelete).not.toHaveBeenCalled();
  });
});
