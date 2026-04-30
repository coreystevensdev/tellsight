import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetChartData = vi.fn();
const mockGetSeedOrgId = vi.fn();
const mockFindOrgById = vi.fn();
const mockGetUserOrgDemoState = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

const mockGetDatasetsByOrg = vi.fn();
const mockGetCachedSummary = vi.fn();
const mockGetLatestSummary = vi.fn();
const mockGetActiveDatasetId = vi.fn();
const mockGetRowCount = vi.fn();
const mockGetHasMarginSignal = vi.fn();

vi.mock('../db/queries/index.js', () => ({
  chartsQueries: { getChartData: mockGetChartData, getHasMarginSignal: mockGetHasMarginSignal },
  datasetsQueries: { getUserOrgDemoState: mockGetUserOrgDemoState, getDatasetsByOrg: mockGetDatasetsByOrg },
  orgsQueries: { getSeedOrgId: mockGetSeedOrgId, findOrgById: mockFindOrgById, getActiveDatasetId: mockGetActiveDatasetId },
  aiSummariesQueries: { getCachedSummary: mockGetCachedSummary, getLatestSummary: mockGetLatestSummary },
  dataRowsQueries: { getRowCount: mockGetRowCount },
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
}));

const mockWithRlsContext = vi.fn();

vi.mock('../lib/db.js', () => ({
  db: {},
  dbAdmin: { _tag: 'dbAdmin' },
}));

vi.mock('../lib/rls.js', () => ({
  withRlsContext: (...args: unknown[]) => mockWithRlsContext(...args),
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../lib/redis.js', () => ({
  redis: {
    connect: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
  },
}));

vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitPublic: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitAi: (_req: unknown, _res: unknown, next: () => void) => next(),
  rateLimitDashboardCompute: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { AuthenticationError } = await import('../lib/appError.js');
const { createTestApp } = await import('../test/helpers/testApp.js');
const { default: dashboardRouter } = await import('./dashboard.js');

const chartFixture = {
  revenueTrend: [{ month: 'Jan', revenue: 5000 }],
  expenseBreakdown: [{ category: 'Payroll', total: 3000 }],
  availableCategories: ['Payroll', 'Rent'],
  dateRange: { min: '2025-01-01', max: '2025-12-31' },
};

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(dashboardRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChartData.mockResolvedValue(chartFixture);
  mockGetSeedOrgId.mockResolvedValue(99);
  mockGetDatasetsByOrg.mockResolvedValue([{ id: 1 }]);
  mockGetCachedSummary.mockResolvedValue(null);
  mockGetLatestSummary.mockResolvedValue(null);
  mockGetActiveDatasetId.mockResolvedValue(null);
  mockGetRowCount.mockResolvedValue(144);
  mockGetHasMarginSignal.mockResolvedValue(false);
  // withRlsContext executes the callback with a mock tx, query mocks intercept regardless
  mockWithRlsContext.mockImplementation(async (_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({ _tag: 'tx' }));
});

describe('GET /dashboard/charts', () => {
  it('returns seed data for anonymous request', async () => {
    const res = await fetch(`${baseUrl}/dashboard/charts`);
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(true);
    expect(body.data.orgName).toBe('Sunrise Cafe');
    expect(body.data.demoState).toBe('seed_only');
    expect(body.data.hasMarginSignal).toBe(false);
    expect(mockGetSeedOrgId).toHaveBeenCalledOnce();
    expect(mockGetChartData).toHaveBeenCalledWith(99, undefined, undefined, expect.anything());
  });

  it('returns user org data for valid JWT', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '42',
      org_id: 10,
      role: 'owner',
      isAdmin: false,
    });
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Corp', slug: 'acme' });
    mockGetUserOrgDemoState.mockResolvedValueOnce('user_only');
    mockGetHasMarginSignal.mockResolvedValueOnce(true);

    const res = await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(false);
    expect(body.data.orgName).toBe('Acme Corp');
    expect(body.data.demoState).toBe('user_only');
    expect(body.data.hasMarginSignal).toBe(true);
    expect(mockWithRlsContext).toHaveBeenCalledWith(10, false, expect.any(Function));
    expect(mockGetChartData).toHaveBeenCalledWith(10, undefined, undefined, expect.anything(), 1);
    expect(mockGetSeedOrgId).not.toHaveBeenCalled();
  });

  it('falls back to seed data on invalid JWT', async () => {
    mockVerifyAccessToken.mockRejectedValueOnce(new AuthenticationError('expired'));

    const res = await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=expired-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(true);
    expect(body.data.orgName).toBe('Sunrise Cafe');
    expect(body.data.demoState).toBe('seed_only');
    expect(mockGetSeedOrgId).toHaveBeenCalledOnce();
  });

  it('fires trackEvent for authenticated users only', async () => {
    // anonymous request, no tracking
    await fetch(`${baseUrl}/dashboard/charts`);
    expect(mockTrackEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetChartData.mockResolvedValue(chartFixture);
    mockGetSeedOrgId.mockResolvedValue(99);
    mockGetDatasetsByOrg.mockResolvedValue([{ id: 1 }]);
    mockGetHasMarginSignal.mockResolvedValue(false);
    mockWithRlsContext.mockImplementation(async (_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({ _tag: 'tx' }));

    // authenticated request, should track
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '42',
      org_id: 10,
      role: 'owner',
      isAdmin: false,
    });
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Corp', slug: 'acme' });
    mockGetUserOrgDemoState.mockResolvedValueOnce('user_only');

    await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(10, 42, 'dashboard.viewed', {
      isDemo: false,
      chartCount: 2,
    });
  });

  it('returns response with availableCategories and dateRange', async () => {
    const res = await fetch(`${baseUrl}/dashboard/charts`);
    const body = await res.json() as { data: Record<string, unknown> };

    expect(body.data.availableCategories).toEqual(['Payroll', 'Rent']);
    expect(body.data.dateRange).toEqual({ min: '2025-01-01', max: '2025-12-31' });
  });

  it('passes filter params to getChartData', async () => {
    const res = await fetch(
      `${baseUrl}/dashboard/charts?from=2025-03-01&to=2025-06-30&categories=Payroll,Rent`,
    );

    expect(res.status).toBe(200);
    expect(mockGetChartData).toHaveBeenCalledWith(
      99,
      expect.objectContaining({
        dateFrom: expect.any(Date),
        dateTo: expect.any(Date),
        categories: ['Payroll', 'Rent'],
      }),
      undefined,
      expect.anything(),
    );
  });

  it('ignores invalid date params gracefully', async () => {
    const res = await fetch(`${baseUrl}/dashboard/charts?from=not-a-date&to=also-bad`);

    expect(res.status).toBe(200);
    expect(mockGetChartData).toHaveBeenCalledWith(99, undefined, undefined, expect.anything());
  });

  it('falls back to demoState empty when getUserOrgDemoState fails', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '42',
      org_id: 10,
      role: 'owner',
      isAdmin: false,
    });
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Corp', slug: 'acme' });
    mockGetUserOrgDemoState.mockRejectedValueOnce(new Error('DB timeout'));

    const res = await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(false);
    expect(body.data.orgName).toBe('Acme Corp');
    expect(body.data.demoState).toBe('empty');
  });

  it('does not fire chart.filtered server-side (moved to client FilterBar)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '42',
      org_id: 10,
      role: 'owner',
      isAdmin: false,
    });
    mockFindOrgById.mockResolvedValueOnce({ id: 10, name: 'Acme Corp', slug: 'acme' });
    mockGetUserOrgDemoState.mockResolvedValueOnce('user_only');

    await fetch(`${baseUrl}/dashboard/charts?from=2025-01-01&categories=Rent`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });

    const chartFilteredCalls = mockTrackEvent.mock.calls.filter(
      (c: unknown[]) => c[2] === 'chart.filtered',
    );
    expect(chartFilteredCalls).toHaveLength(0);
  });
});

describe('dataset query param', () => {
  function authSetup(orgId = 10) {
    mockVerifyAccessToken.mockResolvedValueOnce({
      sub: '42',
      org_id: orgId,
      role: 'owner',
      isAdmin: false,
    });
    mockFindOrgById.mockResolvedValueOnce({ id: orgId, name: 'Acme Corp', slug: 'acme' });
    mockGetUserOrgDemoState.mockResolvedValueOnce('user_only');
  }

  it('uses ?dataset= param when dataset belongs to org', async () => {
    authSetup();
    mockGetDatasetsByOrg.mockResolvedValue([
      { id: 1, name: 'Old Data', isSeedData: false },
      { id: 2, name: 'New Data', isSeedData: false },
    ]);
    mockGetActiveDatasetId.mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/dashboard/charts?dataset=2`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.datasetId).toBe(2);
  });

  it('ignores invalid ?dataset=abc and falls back', async () => {
    authSetup();
    mockGetDatasetsByOrg.mockResolvedValue([{ id: 1, name: 'Data', isSeedData: false }]);
    mockGetActiveDatasetId.mockResolvedValue(1);

    const res = await fetch(`${baseUrl}/dashboard/charts?dataset=abc`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.datasetId).toBe(1);
  });

  it('uses active_dataset_id when no query param', async () => {
    authSetup();
    mockGetDatasetsByOrg.mockResolvedValue([
      { id: 3, name: 'Newest', isSeedData: false },
      { id: 2, name: 'Active', isSeedData: false },
    ]);
    mockGetActiveDatasetId.mockResolvedValue(2);

    const res = await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.datasetId).toBe(2);
  });
});

describe('GET /ai-summaries/:datasetId/cached', () => {
  it('returns latest summary for valid datasetId with staleAt=null when fresh', async () => {
    mockGetLatestSummary.mockResolvedValueOnce({
      content: 'Revenue grew 12% month over month.',
      transparencyMetadata: null,
      staleAt: null,
    });

    const res = await fetch(`${baseUrl}/ai-summaries/1/cached`);
    const body = await res.json() as { data: { content: string; staleAt: string | null } };

    expect(res.status).toBe(200);
    expect(body.data.content).toBe('Revenue grew 12% month over month.');
    expect(body.data.staleAt).toBeNull();
    expect(mockGetLatestSummary).toHaveBeenCalledWith(99, 1, expect.anything());
  });

  it('surfaces staleAt ISO string when the summary is stale', async () => {
    const staleAt = new Date('2026-04-17T10:00:00.000Z');
    mockGetLatestSummary.mockResolvedValueOnce({
      content: 'Prior analysis.',
      transparencyMetadata: null,
      staleAt,
    });

    const res = await fetch(`${baseUrl}/ai-summaries/1/cached`);
    const body = await res.json() as { data: { staleAt: string } };

    expect(res.status).toBe(200);
    expect(body.data.staleAt).toBe('2026-04-17T10:00:00.000Z');
  });

  it('returns 404 when no summary exists for the dataset', async () => {
    mockGetLatestSummary.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/ai-summaries/1/cached`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for invalid datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/abc/cached`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for negative datasetId', async () => {
    const res = await fetch(`${baseUrl}/ai-summaries/-5/cached`);
    const body = await res.json() as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
