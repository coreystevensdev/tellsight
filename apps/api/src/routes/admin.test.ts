import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';

const mockVerifyAccessToken = vi.fn();
const mockGetOrgsWithStats = vi.fn();
const mockGetUsers = vi.fn();
const mockGetOrgDetail = vi.fn();
const mockGetSystemHealth = vi.fn();
const mockGetAlertComplianceMetrics = vi.fn();
const mockGetAllAnalyticsEvents = vi.fn();
const mockGetAnalyticsEventsTotal = vi.fn();
const mockAuditQuery = vi.fn();
const mockAuditTotal = vi.fn();
const mockResolveCorrection = vi.fn();
const mockGetPendingCorrections = vi.fn();
const mockFindById = vi.fn();
const mockMarkStale = vi.fn().mockResolvedValue(undefined);
const mockAudit = vi.fn();
const mockUpdateAgentEnabled = vi.fn();
const mockTrackEvent = vi.fn();

vi.mock('../services/auth/tokenService.js', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

vi.mock('../services/admin/index.js', () => ({
  getOrgsWithStats: mockGetOrgsWithStats,
  getUsers: mockGetUsers,
  getOrgDetail: mockGetOrgDetail,
  getSystemHealth: mockGetSystemHealth,
  getAlertComplianceMetrics: mockGetAlertComplianceMetrics,
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
  statCorrectionsQueries: {
    resolveCorrection: (...args: unknown[]) => mockResolveCorrection(...args),
    getPendingCorrections: (...args: unknown[]) => mockGetPendingCorrections(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
  aiSummariesQueries: {
    markStale: (...args: unknown[]) => mockMarkStale(...args),
  },
  subscriptionsQueries: {
    updateAgentEnabled: (...args: unknown[]) => mockUpdateAgentEnabled(...args),
  },
}));

vi.mock('../services/audit/auditService.js', () => ({
  audit: (...args: unknown[]) => mockAudit(...args),
}));

vi.mock('../services/analytics/trackEvent.js', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

vi.mock('../lib/db.js', () => ({
  dbAdmin: { __tag: 'dbAdmin' },
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

const fakeAlertMetrics = {
  totalRules: 12,
  mutedRules: 2,
  d7: { fired: 5, quotaSuppressed: 1 },
  d30: { fired: 20, quotaSuppressed: 3 },
  byRuleKind: [
    { ruleKind: 'runway_runs_short', totalRules: 4, fired: 8, clicked: 2, candidateDefaultOffRules: 1 },
  ],
  computedAt: '2026-07-18T00:00:00.000Z',
};

describe('GET /admin/alert-compliance', () => {
  it('returns 200 with alert compliance metrics for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetAlertComplianceMetrics.mockResolvedValueOnce(fakeAlertMetrics);

    const res = await fetch(`${baseUrl}/admin/alert-compliance`, { headers: authHeaders });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakeAlertMetrics);
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/alert-compliance`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/alert-compliance`);
    expect(res.status).toBe(401);
  });
});

const fakePendingCorrections = [
  {
    id: 1, orgId: 1, orgName: 'Acme', datasetId: 5, datasetName: 'Q3 Books',
    statInstanceId: '5:runway:_:_', note: 'This double-counts the SBA loan.',
    appliesGoingForward: true, createdAt: '2026-07-20T12:00:00.000Z',
  },
  {
    id: 2, orgId: 2, orgName: 'Widgets Co', datasetId: 9, datasetName: 'FY26',
    statInstanceId: '9:anomaly:_:_', note: 'One-time refund, not a trend.',
    appliesGoingForward: true, createdAt: '2026-07-21T09:00:00.000Z',
  },
];

describe('GET /admin/stat-corrections', () => {
  it('returns 200 with pending corrections across orgs for admin', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetPendingCorrections.mockResolvedValueOnce(fakePendingCorrections);

    const res = await fetch(`${baseUrl}/admin/stat-corrections`, { headers: authHeaders });
    const json = (await res.json()) as { data: unknown; meta: { total: number } };

    expect(res.status).toBe(200);
    expect(json.data).toEqual(fakePendingCorrections);
    expect(json.meta.total).toBe(2);
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/stat-corrections`, { headers: authHeaders });
    expect(res.status).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/stat-corrections`);
    expect(res.status).toBe(401);
  });
});

const fakeCorrection = {
  id: 3,
  orgId: 10,
  datasetId: 7,
  statInstanceId: '7:runway:_:_',
  status: 'approved',
  expiresAt: '2026-10-20T00:00:00.000Z',
};

describe('PATCH /admin/stat-corrections/:orgId/:id', () => {
  it('approves a pending correction and computes expiresAt from expiresInDays', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(fakeCorrection);

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved', expiresInDays: 90 }),
    });
    const json = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('approved');
    expect(mockResolveCorrection).toHaveBeenCalledWith(
      3,
      10,
      1,
      { status: 'approved', expiresAt: expect.any(Date) },
    );
  });

  it('invalidates the org+dataset ai_summaries cache on approval so the exclusion is visible immediately (AC)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(fakeCorrection);

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved', expiresInDays: 90 }),
    });

    expect(res.status).toBe(200);
    expect(mockMarkStale).toHaveBeenCalledWith(10, { __tag: 'dbAdmin' }, 7);
  });

  it('writes an audit log with the target org id, not the resolving admin\'s own org', async () => {
    // Platform admin's own org (99) differs from the org being corrected (10)
    // on purpose, this is the exact distinction the audit call has to get right.
    mockVerifyAccessToken.mockResolvedValueOnce({ ...adminPayload(), org_id: 99 });
    mockResolveCorrection.mockResolvedValueOnce(fakeCorrection);

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved', expiresInDays: 90 }),
    });

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [, entry] = mockAudit.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(entry).toMatchObject({
      orgId: 10,
      userId: 1,
      action: 'admin.stat_correction_resolved',
      targetType: 'stat_correction',
      targetId: '3',
      metadata: { status: 'approved' },
    });
  });

  it('includes expiresInDays and expiresAt in the audit metadata on approval', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(fakeCorrection);

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved', expiresInDays: 90 }),
    });

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [, entry] = mockAudit.mock.calls[0] as [unknown, { metadata: Record<string, unknown> }];
    // pin the audit-logged expiresAt to the exact value resolveCorrection was
    // told to persist, not just "some ISO string" -- that's the whole point of DW-129
    const [, , , resolution] = mockResolveCorrection.mock.calls[0] as [unknown, unknown, unknown, { expiresAt: Date }];
    expect(entry.metadata).toEqual({
      status: 'approved',
      expiresInDays: 90,
      expiresAt: resolution.expiresAt.toISOString(),
    });
  });

  it('rejects a pending correction without requiring expiresInDays', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce({ ...fakeCorrection, status: 'rejected', expiresAt: null });

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });
    const json = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(json.data.status).toBe('rejected');
    expect(mockResolveCorrection).toHaveBeenCalledWith(3, 10, 1, { status: 'rejected' });
    // Rejection has no scoring effect, ever, so nothing to invalidate.
    expect(mockMarkStale).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [, entry] = mockAudit.mock.calls[0] as [unknown, { metadata: Record<string, unknown> }];
    expect(entry.metadata).toEqual({ status: 'rejected' });
  });

  it('rejects an approval missing expiresInDays', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockResolveCorrection).not.toHaveBeenCalled();
  });

  it('rejects an expiresInDays out of the 1-365 range', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'approved', expiresInDays: 400 }),
    });

    expect(res.status).toBe(400);
    expect(mockResolveCorrection).not.toHaveBeenCalled();
  });

  it('returns 404 when the correction id does not exist for the org', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(null);
    mockFindById.mockResolvedValueOnce(null);

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('NOT_FOUND');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns 409 when the correction is already resolved (race guard)', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(null);
    mockFindById.mockResolvedValueOnce({ ...fakeCorrection, status: 'approved' });

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });
    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT');
    expect(json.error.message).toContain('approved');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns 409 when the correction has already expired', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(null);
    mockFindById.mockResolvedValueOnce({ ...fakeCorrection, status: 'expired' });

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });
    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('CONFLICT');
    expect(json.error.message).toContain('expired');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns 400 when the correction is a Tier 1 annotation never queued for review', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockResolveCorrection.mockResolvedValueOnce(null);
    mockFindById.mockResolvedValueOnce({ ...fakeCorrection, status: null });

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user, correcting org cannot self-approve', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/stat-corrections/10/3`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'rejected' }),
    });

    expect(res.status).toBe(403);
    expect(mockResolveCorrection).not.toHaveBeenCalled();
  });
});

describe('PATCH /admin/orgs/:orgId/agent-tier', () => {
  const fakeOrg = { id: 10, name: 'Acme', members: [], datasets: [], subscription: null };

  it('enables the Agent tier for an org with no prior subscription row, writes an audit row, and tracks the transition', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetOrgDetail.mockResolvedValueOnce(fakeOrg);

    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    const json = (await res.json()) as { data: { orgId: number; agentEnabled: boolean } };

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ orgId: 10, agentEnabled: true });
    expect(mockGetOrgDetail).toHaveBeenCalledWith(10);
    expect(mockUpdateAgentEnabled).toHaveBeenCalledWith(10, true, { __tag: 'dbAdmin' });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 10,
        userId: 1,
        action: 'admin.agent_tier_enabled',
        targetType: 'subscription',
        targetId: '10',
        metadata: { enabled: true },
      }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 1, 'subscription.agent_tier_enabled', { enabled: true });
  });

  it('disables the Agent tier and writes the disabled audit action and event', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    mockGetOrgDetail.mockResolvedValueOnce(fakeOrg);

    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    const json = (await res.json()) as { data: { agentEnabled: boolean } };

    expect(res.status).toBe(200);
    expect(json.data.agentEnabled).toBe(false);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'admin.agent_tier_disabled', metadata: { enabled: false } }),
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(10, 1, 'subscription.agent_tier_disabled', { enabled: false });
  });

  it('returns 404 when the org itself does not exist, and never touches the subscription', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());
    const { NotFoundError } = await import('../lib/appError.js');
    mockGetOrgDetail.mockRejectedValueOnce(new NotFoundError('Org 10 not found'));

    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(json.error.code).toBe('NOT_FOUND');
    expect(mockUpdateAgentEnabled).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-boolean enabled value', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: 'yes' }),
    });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdateAgentEnabled).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-numeric orgId', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(adminPayload());

    const res = await fetch(`${baseUrl}/admin/orgs/abc/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(400);
    expect(mockUpdateAgentEnabled).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    mockVerifyAccessToken.mockResolvedValueOnce(regularPayload());

    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(403);
    expect(mockUpdateAgentEnabled).not.toHaveBeenCalled();
  });

  it('returns 401 without auth', async () => {
    const res = await fetch(`${baseUrl}/admin/orgs/10/agent-tier`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(401);
  });
});
