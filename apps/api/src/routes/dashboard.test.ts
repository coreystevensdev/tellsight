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

vi.mock('../db/queries/index.js', () => ({
  chartsQueries: { getChartData: mockGetChartData },
  datasetsQueries: { getUserOrgDemoState: mockGetUserOrgDemoState },
  orgsQueries: { getSeedOrgId: mockGetSeedOrgId, findOrgById: mockFindOrgById },
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: mockTrackEvent,
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
}));

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
});

describe('GET /dashboard/charts', () => {
  it('returns seed data for anonymous request', async () => {
    const res = await fetch(`${baseUrl}/dashboard/charts`);
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(true);
    expect(body.data.orgName).toBe('Sunrise Cafe');
    expect(body.data.demoState).toBe('seed_only');
    expect(mockGetSeedOrgId).toHaveBeenCalledOnce();
    expect(mockGetChartData).toHaveBeenCalledWith(99, undefined);
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

    const res = await fetch(`${baseUrl}/dashboard/charts`, {
      headers: { Cookie: 'access_token=valid-jwt' },
    });
    const body = await res.json() as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data.isDemo).toBe(false);
    expect(body.data.orgName).toBe('Acme Corp');
    expect(body.data.demoState).toBe('user_only');
    expect(mockGetChartData).toHaveBeenCalledWith(10, undefined);
    expect(mockGetSeedOrgId).not.toHaveBeenCalled();
  });

  it('falls back to seed data on invalid JWT', async () => {
    mockVerifyAccessToken.mockRejectedValueOnce(new Error('expired'));

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
    // anonymous request — no tracking
    await fetch(`${baseUrl}/dashboard/charts`);
    expect(mockTrackEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockGetChartData.mockResolvedValue(chartFixture);
    mockGetSeedOrgId.mockResolvedValue(99);

    // authenticated request — should track
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
    );
  });

  it('ignores invalid date params gracefully', async () => {
    const res = await fetch(`${baseUrl}/dashboard/charts?from=not-a-date&to=also-bad`);

    expect(res.status).toBe(200);
    expect(mockGetChartData).toHaveBeenCalledWith(99, undefined);
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

  it('fires chart.filtered event when filters are present', async () => {
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

    expect(mockTrackEvent).toHaveBeenCalledWith(10, 42, 'chart.filtered', {
      dateFrom: expect.any(String),
      dateTo: undefined,
      categories: ['Rent'],
    });
  });
});
