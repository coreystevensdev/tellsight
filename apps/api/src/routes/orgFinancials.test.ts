import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetOrgFinancials = vi.fn();
const mockUpdateOrgFinancials = vi.fn();
const mockGetCashBalanceHistory = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockGetRowsByDataset = vi.fn();
const mockGetMonthlyBucketsByDataset = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../db/queries/index.js', () => ({
  orgFinancialsQueries: {
    getOrgFinancials: mockGetOrgFinancials,
    updateOrgFinancials: mockUpdateOrgFinancials,
    getCashBalanceHistory: mockGetCashBalanceHistory,
  },
  orgsQueries: {
    getActiveDatasetId: mockGetActiveDatasetId,
  },
  dataRowsQueries: {
    getRowsByDataset: mockGetRowsByDataset,
    getMonthlyBucketsByDataset: mockGetMonthlyBucketsByDataset,
  },
  auditLogsQueries: {
    record: vi.fn().mockResolvedValue(undefined),
  },
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
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { orgFinancialsRouter } = await import('./orgFinancials.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/org', orgFinancialsRouter);
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

describe('GET /org/financials', () => {
  it('returns current financials', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce({
      cashOnHand: 15000,
      cashAsOfDate: '2026-04-15T00:00:00.000Z',
    });

    const res = await fetch(`${baseUrl}/org/financials`, { headers: authHeaders });
    const json = (await res.json()) as { data: { cashOnHand: number } };

    expect(res.status).toBe(200);
    expect(json.data.cashOnHand).toBe(15000);
  });

  it('returns empty object when no profile exists', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/org/financials`, { headers: authHeaders });
    const json = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(json.data).toEqual({});
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/org/financials`);
    expect(res.status).toBe(401);
  });

  it('allows members (read is not owner-gated)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));
    mockGetOrgFinancials.mockResolvedValueOnce({ cashOnHand: 5000 });

    const res = await fetch(`${baseUrl}/org/financials`, { headers: authHeaders });
    expect(res.status).toBe(200);
  });
});

describe('PUT /org/financials', () => {
  it('updates cash balance as owner and fires runway.enabled on first cash balance', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce(null); // no prior balance
    mockUpdateOrgFinancials.mockResolvedValueOnce({
      cashOnHand: 25000,
      cashAsOfDate: expect.any(String),
    });

    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cashOnHand: 25000 }),
    });

    expect(res.status).toBe(200);
    expect(mockUpdateOrgFinancials).toHaveBeenCalledTimes(1);
    const [orgId, updates] = mockUpdateOrgFinancials.mock.calls[0]!;
    expect(orgId).toBe(10);
    expect(updates.cashOnHand).toBe(25000);
    expect(updates.cashAsOfDate).toBeDefined();

    // Analytics — both events fire on the first cash balance submission
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'financials.updated', {
      fields: expect.arrayContaining(['cashOnHand']),
    });
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 5, 'runway.enabled', { cashOnHand: 25000 });
  });

  it('fires only financials.updated (not runway.enabled) on subsequent updates', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce({ cashOnHand: 10000 }); // already set
    mockUpdateOrgFinancials.mockResolvedValueOnce({ cashOnHand: 25000 });

    await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cashOnHand: 25000 }),
    });

    const events = mockTrackEvent.mock.calls.map((c) => c[2]);
    expect(events).toContain('financials.updated');
    expect(events).not.toContain('runway.enabled');
  });

  it('rejects non-owner PUT with 403', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload({ role: 'member' }));

    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cashOnHand: 1000 }),
    });

    expect(res.status).toBe(403);
    expect(mockUpdateOrgFinancials).not.toHaveBeenCalled();
  });

  it('rejects negative cashOnHand', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cashOnHand: -500 }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateOrgFinancials).not.toHaveBeenCalled();
  });

  it('rejects cashOnHand over cap', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ cashOnHand: 1_000_000_000 }),
    });

    expect(res.status).toBe(400);
  });

  it('accepts empty object (partial update with no fields)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockUpdateOrgFinancials.mockResolvedValueOnce({});

    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/org/financials`, {
      method: 'PUT',
      body: JSON.stringify({ cashOnHand: 1000 }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /org/financials/cash-history', () => {
  it('returns history with default limit', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetCashBalanceHistory.mockResolvedValueOnce([
      { balance: 15000, asOfDate: '2026-04-15T00:00:00.000Z' },
      { balance: 20000, asOfDate: '2026-03-15T00:00:00.000Z' },
    ]);

    const res = await fetch(`${baseUrl}/org/financials/cash-history`, { headers: authHeaders });
    const json = (await res.json()) as { data: Array<{ balance: number }> };

    expect(res.status).toBe(200);
    expect(json.data).toHaveLength(2);
    expect(mockGetCashBalanceHistory).toHaveBeenCalledWith(10, 12, expect.anything());
  });

  it('respects custom limit', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetCashBalanceHistory.mockResolvedValueOnce([]);

    await fetch(`${baseUrl}/org/financials/cash-history?limit=24`, { headers: authHeaders });

    expect(mockGetCashBalanceHistory).toHaveBeenCalledWith(10, 24, expect.anything());
  });

  it('rejects invalid limit', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/financials/cash-history?limit=999`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(400);
  });
});

// 6-month burning-business bucket map — revenue 10k, expenses 15k per month.
// Matches the shape the SQL-backed query returns.
function burningBuckets() {
  const map = new Map<string, { revenue: number; expenses: number }>();
  for (let m = 1; m <= 6; m++) {
    const key = `2026-${String(m).padStart(2, '0')}`;
    map.set(key, { revenue: 10_000, expenses: 15_000 });
  }
  return map;
}

describe('GET /org/financials/cash-forecast', () => {
  it('returns forecast payload when cashOnHand + aggregated buckets yield a valid projection', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce({
      cashOnHand: 40_000,
      cashAsOfDate: new Date().toISOString(),
    });
    mockGetActiveDatasetId.mockResolvedValueOnce(7);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(burningBuckets());

    const res = await fetch(`${baseUrl}/org/financials/cash-forecast?months=3`, { headers: authHeaders });
    const json = (await res.json()) as {
      data: {
        startingBalance: number;
        forecast: Array<{ balance: number; asOfDate: string; month: string }>;
        method: string;
        confidence: string;
      } | null;
    };

    expect(res.status).toBe(200);
    expect(json.data).not.toBeNull();
    expect(json.data!.startingBalance).toBe(40_000);
    expect(json.data!.forecast).toHaveLength(3);
    expect(json.data!.method).toBe('linear_regression');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      10,
      5,
      'forecast.requested',
      expect.objectContaining({ method: 'linear_regression' }),
    );
  });

  it('returns data: null when cashOnHand is absent', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce({}); // no cashOnHand
    mockGetActiveDatasetId.mockResolvedValueOnce(7);
    mockGetMonthlyBucketsByDataset.mockResolvedValueOnce(burningBuckets());

    const res = await fetch(`${baseUrl}/org/financials/cash-forecast`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown };

    expect(res.status).toBe(200);
    expect(json.data).toBeNull();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns data: null when the org has no active dataset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());
    mockGetOrgFinancials.mockResolvedValueOnce({
      cashOnHand: 40_000,
      cashAsOfDate: new Date().toISOString(),
    });
    mockGetActiveDatasetId.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/org/financials/cash-forecast`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown };

    expect(res.status).toBe(200);
    expect(json.data).toBeNull();
    expect(mockGetMonthlyBucketsByDataset).not.toHaveBeenCalled();
  });

  it('rejects unauthorized requests', async () => {
    const res = await fetch(`${baseUrl}/org/financials/cash-forecast`);
    expect(res.status).toBe(401);
  });

  it('rejects invalid months parameter (too high)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/financials/cash-forecast?months=4`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it('rejects invalid months parameter (non-numeric)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(ownerPayload());

    const res = await fetch(`${baseUrl}/org/financials/cash-forecast?months=abc`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });
});
