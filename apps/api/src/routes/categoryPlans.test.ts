import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockDelete = vi.fn();
const mockTrackEvent = vi.fn();
const mockAuditAuth = vi.fn();

vi.mock('../services/audit/auditService.js', () => ({
  audit: vi.fn(),
  auditAuth: (...args: unknown[]) => mockAuditAuth(...args),
}));

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  categoryPlansQueries: {
    listCategoryPlans: mockList,
    upsertCategoryPlans: mockUpsert,
    deleteCategoryPlan: mockDelete,
  },
  auditLogsQueries: { record: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../services/analytics/trackEvent.js', () => ({ trackEvent: mockTrackEvent }));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', APP_URL: 'http://localhost:3000' },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { categoryPlansRouter } = await import('./categoryPlans.js');
const { withRlsContext } = await import('../lib/rls.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/org', categoryPlansRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => vi.clearAllMocks());

function payload(overrides: Partial<{ role: string; org_id: number }> = {}) {
  return {
    sub: '5', org_id: 10, role: 'owner', isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  };
}

const authHeaders = { Cookie: 'access_token=valid-jwt', 'Content-Type': 'application/json' };

describe('GET /org/category-plans', () => {
  it('returns the org plans', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockList.mockResolvedValueOnce([{ category: 'Rent', plannedMonthly: 2400 }]);

    const res = await fetch(`${baseUrl}/org/category-plans`, { headers: authHeaders });
    const json = (await res.json()) as { data: { category: string }[] };

    expect(res.status).toBe(200);
    expect(json.data).toEqual([{ category: 'Rent', plannedMonthly: 2400 }]);
  });

  // Reading is member-level on purpose: the variance stat reads these and goes
  // into the digest every member receives.
  it('lets a member read', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload({ role: 'member' }));
    mockList.mockResolvedValueOnce([]);

    expect((await fetch(`${baseUrl}/org/category-plans`, { headers: authHeaders })).status).toBe(200);
  });

  it('scopes the read to the caller org through RLS context', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload({ org_id: 77 }));
    mockList.mockResolvedValueOnce([]);

    await fetch(`${baseUrl}/org/category-plans`, { headers: authHeaders });

    expect(withRlsContext).toHaveBeenCalledWith(77, false, expect.any(Function));
    expect(mockList).toHaveBeenCalledWith(77, expect.anything());
  });
});

describe('PUT /org/category-plans', () => {
  const body = JSON.stringify({ plans: [{ category: 'Rent', plannedMonthly: 2400 }] });

  it('upserts and returns the full set', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockUpsert.mockResolvedValueOnce([{ category: 'Rent', plannedMonthly: 2400 }]);

    const res = await fetch(`${baseUrl}/org/category-plans`, { method: 'PUT', headers: authHeaders, body });
    const json = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(1);
  });

  // The authorization half. Authn alone would let any member rewrite the
  // owner's budget.
  it('rejects a member', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/category-plans`, { method: 'PUT', headers: authHeaders, body });

    expect(res.status).toBe(403);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('rejects a negative amount', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());

    const res = await fetch(`${baseUrl}/org/category-plans`, {
      method: 'PUT', headers: authHeaders,
      body: JSON.stringify({ plans: [{ category: 'Rent', plannedMonthly: -1 }] }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  // What an owner budgets is as sensitive as what they hold, so the audit
  // records which categories moved and never the figures.
  it('audits categories without the amounts', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockUpsert.mockResolvedValueOnce([]);

    await fetch(`${baseUrl}/org/category-plans`, { method: 'PUT', headers: authHeaders, body });

    const [, , opts] = mockAuditAuth.mock.calls[0] as [unknown, unknown, { metadata: Record<string, unknown> }];
    expect(opts.metadata).toEqual({ categories: ['Rent'] });
    expect(JSON.stringify(opts.metadata)).not.toContain('2400');
  });
});

describe('DELETE /org/category-plans/:category', () => {
  it('answers 204 when a plan was removed', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockDelete.mockResolvedValueOnce(true);

    const res = await fetch(`${baseUrl}/org/category-plans/Rent`, { method: 'DELETE', headers: authHeaders });

    expect(res.status).toBe(204);
  });

  // Distinguishable from a successful delete, so a UI reconciling state can
  // tell "gone" from "was never there".
  it('answers 404 when there was no plan', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockDelete.mockResolvedValueOnce(false);

    const res = await fetch(`${baseUrl}/org/category-plans/Rent`, { method: 'DELETE', headers: authHeaders });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('NOT_FOUND');
  });

  it('rejects a member', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/category-plans/Rent`, { method: 'DELETE', headers: authHeaders });

    expect(res.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // Categories are free text from the source data, so they arrive encoded.
  it('decodes a category containing a space and an ampersand', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(payload());
    mockDelete.mockResolvedValueOnce(true);

    await fetch(`${baseUrl}/org/category-plans/${encodeURIComponent('Meals & Travel')}`, {
      method: 'DELETE', headers: authHeaders,
    });

    expect(mockDelete).toHaveBeenCalledWith(10, 'Meals & Travel', expect.anything());
  });
});
