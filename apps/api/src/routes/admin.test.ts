import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetOrgsWithStats = vi.fn();
const mockGetUsers = vi.fn();
const mockGetOrgDetail = vi.fn();
const mockGetSystemHealth = vi.fn();
const mockGetAllAnalyticsEvents = vi.fn();
const mockGetAnalyticsEventsTotal = vi.fn();
const mockAuditQuery = vi.fn();
const mockAuditTotal = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../services/admin/index.js', () => ({
  getOrgsWithStats: mockGetOrgsWithStats,
  getUsers: mockGetUsers,
  getOrgDetail: mockGetOrgDetail,
  getSystemHealth: mockGetSystemHealth,
}));

vi.mock('../db/queries/analyticsEvents.js', () => ({
  getAllAnalyticsEvents: mockGetAllAnalyticsEvents,
  getAnalyticsEventsTotal: mockGetAnalyticsEventsTotal,
}));

vi.mock('../db/queries/index.js', () => ({
  auditLogsQueries: {
    query: (...args: unknown[]) => mockAuditQuery(...args),
    total: (...args: unknown[]) => mockAuditTotal(...args),
  },
}));

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test', APP_URL: 'http://localhost:3000' },
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
const { roleGuard } = await import('../middleware/roleGuard.js');
const { adminRouter } = await import('./admin.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(authMiddleware);
    app.use('/admin', roleGuard('admin'), adminRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => vi.clearAllMocks());

function adminPayload() {
  return {
    sub: '1',
    org_id: 10,
    role: 'owner' as const,
    isAdmin: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

function regularPayload() {
  return {
    sub: '2',
    org_id: 10,
    role: 'member' as const,
    isAdmin: false,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
  };
}

const authHeaders = {
  Cookie: 'access_token=valid-jwt',
  'Content-Type': 'application/json',
};

const fakeOrgs = [
  { id: 1, name: 'Acme', slug: 'acme', memberCount: 3, datasetCount: 2, subscriptionTier: 'pro', createdAt: '2026-01-01' },
];
const fakeStats = { totalOrgs: 1, totalUsers: 1, proSubscribers: 1 };
const fakeUsers = [
  { id: 1, email: 'a@b.com', name: 'Alice', isPlatformAdmin: true, orgs: [], createdAt: '2026-01-01' },
];

describe('GET /admin/orgs', () => {
  it('returns 200 with org list for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetOrgsWithStats.mockResolvedValueOnce({ orgs: fakeOrgs, stats: fakeStats });

    const res = await fetch(`${baseUrl}/admin/orgs`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeOrgs);
    expect(json.meta.total).toBe(1);
    expect(json.meta.stats).toEqual(fakeStats);
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/orgs`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/orgs`);
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/users', () => {
  it('returns 200 with user list for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetUsers.mockResolvedValueOnce(fakeUsers);

    const res = await fetch(`${baseUrl}/admin/users`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeUsers);
    expect(json.meta.total).toBe(1);
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/users`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });
});

describe('GET /admin/orgs/:orgId', () => {
  it('returns 200 with org detail for admin', async () => {
    const fakeOrg = { id: 1, name: 'Acme', members: [], datasets: [], subscription: null };
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetOrgDetail.mockResolvedValueOnce(fakeOrg);

    const res = await fetch(`${baseUrl}/admin/orgs/1`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeOrg);
    expect(mockGetOrgDetail).toHaveBeenCalledWith(1);
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/orgs/1`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 404 when org not found', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    const { NotFoundError } = await import('../lib/appError.js');
    mockGetOrgDetail.mockRejectedValueOnce(new NotFoundError('Org 999 not found'));

    const res = await fetch(`${baseUrl}/admin/orgs/999`, { headers: authHeaders });
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric orgId', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/orgs/abc`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });
});

const fakeHealth = {
  services: {
    database: { status: 'ok', latencyMs: 2 },
    redis: { status: 'ok', latencyMs: 1 },
    claude: { status: 'ok', latencyMs: 50 },
  },
  uptime: { seconds: 3600, formatted: '1h 0m' },
  timestamp: '2026-03-30T12:00:00.000Z',
};

describe('GET /admin/health', () => {
  it('returns 200 with health data for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetSystemHealth.mockResolvedValueOnce(fakeHealth);

    const res = await fetch(`${baseUrl}/admin/health`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeHealth);
    expect(json.data.services.database).toHaveProperty('status');
    expect(json.data.services.redis).toHaveProperty('status');
    expect(json.data.services.claude).toHaveProperty('status');
    expect(json.data.uptime).toHaveProperty('seconds');
    expect(json.data.uptime).toHaveProperty('formatted');
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/health`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/health`);
    expect(res.status).toBe(401);
  });
});

const fakeEvents = [
  {
    id: 1, eventName: 'user.signed_in', orgName: 'Acme', userEmail: 'a@b.com',
    userName: 'Alice', metadata: null, createdAt: '2026-03-30T12:00:00.000Z',
  },
];

describe('GET /admin/analytics-events', () => {
  it('returns 200 with paginated events for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetAllAnalyticsEvents.mockResolvedValueOnce(fakeEvents);
    mockGetAnalyticsEventsTotal.mockResolvedValueOnce(1);

    const res = await fetch(`${baseUrl}/admin/analytics-events`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeEvents);
    expect(json.meta.total).toBe(1);
    expect(json.meta.pagination).toEqual({ page: 1, pageSize: 50, totalPages: 1 });
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/analytics-events`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics-events`);
    expect(res.status).toBe(401);
  });

  it('passes valid filters to query functions', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetAllAnalyticsEvents.mockResolvedValueOnce([]);
    mockGetAnalyticsEventsTotal.mockResolvedValueOnce(0);

    const params = new URLSearchParams({
      eventName: 'user.signed_in',
      orgId: '5',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.000Z',
      limit: '25',
      offset: '50',
    });

    const res = await fetch(`${baseUrl}/admin/analytics-events?${params}`, { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(mockGetAllAnalyticsEvents).toHaveBeenCalledWith({
      eventName: 'user.signed_in',
      orgId: 5,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-03-31T23:59:59.000Z'),
      limit: 25,
      offset: 50,
    });
  });

  it('returns 400 for invalid limit', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/analytics-events?limit=999`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative offset', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/analytics-events?offset=-1`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it('calculates pagination meta correctly', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetAllAnalyticsEvents.mockResolvedValueOnce([]);
    mockGetAnalyticsEventsTotal.mockResolvedValueOnce(120);

    const res = await fetch(`${baseUrl}/admin/analytics-events?limit=25&offset=50`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (await res.json()) as any;

    expect(json.meta.pagination).toEqual({ page: 3, pageSize: 25, totalPages: 5 });
  });
});

const fakeAuditLogs = [
  {
    id: 1, action: 'auth.login', targetType: null, targetId: null,
    orgName: 'Acme', userEmail: 'a@b.com', userName: 'Alice',
    metadata: { isNewUser: false }, ipAddress: '192.168.1.1',
    createdAt: '2026-04-10T12:00:00.000Z',
  },
];

describe('GET /admin/audit-logs', () => {
  it('returns 200 with paginated audit logs for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockAuditQuery.mockResolvedValueOnce(fakeAuditLogs);
    mockAuditTotal.mockResolvedValueOnce(1);

    const res = await fetch(`${baseUrl}/admin/audit-logs`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeAuditLogs);
    expect(json.meta.total).toBe(1);
    expect(json.meta.pagination).toEqual({ page: 1, pageSize: 50, totalPages: 1 });
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/audit-logs`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/audit-logs`);
    expect(res.status).toBe(401);
  });

  it('passes valid filters to query functions', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockAuditQuery.mockResolvedValueOnce([]);
    mockAuditTotal.mockResolvedValueOnce(0);

    const params = new URLSearchParams({
      action: 'auth.login',
      orgId: '5',
      userId: '3',
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-03-31T23:59:59.000Z',
      limit: '25',
      offset: '50',
    });

    const res = await fetch(`${baseUrl}/admin/audit-logs?${params}`, { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(mockAuditQuery).toHaveBeenCalledWith({
      action: 'auth.login',
      orgId: 5,
      userId: 3,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-03-31T23:59:59.000Z'),
      limit: 25,
      offset: 50,
    });
  });

  it('returns 400 for invalid limit', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/audit-logs?limit=999`, { headers: authHeaders });
    expect(res.status).toBe(400);
  });

  it('calculates pagination meta correctly', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockAuditQuery.mockResolvedValueOnce([]);
    mockAuditTotal.mockResolvedValueOnce(200);

    const res = await fetch(`${baseUrl}/admin/audit-logs?limit=25&offset=75`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json()) as any;

    expect(json.meta.pagination).toEqual({ page: 4, pageSize: 25, totalPages: 8 });
  });
});
