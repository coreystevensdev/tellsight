import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockInnerJoin = vi.fn();
const mockGroupBy = vi.fn();
const mockOrderBy = vi.fn();
const mockWhere = vi.fn();

const chainable = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  groupBy: mockGroupBy,
  orderBy: mockOrderBy,
  where: mockWhere,
};

// each method returns the chain so calls can be chained
for (const fn of Object.values(chainable)) {
  fn.mockReturnValue(chainable);
}

vi.mock('../../lib/db.js', () => ({
  db: {
    select: mockSelect,
    query: { orgs: { findFirst: vi.fn() } },
  },
  dbAdmin: {
    select: mockSelect,
    query: { orgs: { findFirst: vi.fn() } },
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...exprs: unknown[]) =>
      strings.reduce((acc, str, i) => acc + str + (i < exprs.length ? String(exprs[i]) : ''), ''),
    { raw: (s: string) => s },
  ),
  count: vi.fn(() => 'count'),
}));

vi.mock('../schema.js', () => ({
  orgs: { id: 'orgs.id', name: 'orgs.name', slug: 'orgs.slug', createdAt: 'orgs.createdAt' },
  users: { id: 'users.id', email: 'users.email', name: 'users.name', isPlatformAdmin: 'users.isPlatformAdmin', createdAt: 'users.createdAt' },
  userOrgs: { userId: 'userOrgs.userId', orgId: 'userOrgs.orgId', role: 'userOrgs.role', joinedAt: 'userOrgs.joinedAt' },
  datasets: { id: 'datasets.id', name: 'datasets.name', orgId: 'datasets.orgId', isSeedData: 'datasets.isSeedData', createdAt: 'datasets.createdAt' },
  subscriptions: { plan: 'subscriptions.plan', status: 'subscriptions.status', orgId: 'subscriptions.orgId' },
  analyticsEvents: { id: 'ae.id', orgId: 'ae.orgId', eventName: 'ae.eventName', metadata: 'ae.metadata', createdAt: 'ae.createdAt' },
}));

const mockGetMonthToDateAiUsage = vi.fn();
vi.mock('./analyticsEvents.js', () => ({
  getMonthToDateAiUsage: mockGetMonthToDateAiUsage,
}));

beforeEach(() => vi.clearAllMocks());

describe('admin queries', () => {
  describe('getAllOrgs', () => {
    it('returns orgs with counts', async () => {
      const fakeOrgs = [
        { id: 1, name: 'Acme', slug: 'acme', createdAt: new Date(), memberCount: 3, datasetCount: 2, subscriptionTier: 'pro' },
        { id: 2, name: 'Biz', slug: 'biz', createdAt: new Date(), memberCount: 1, datasetCount: 0, subscriptionTier: 'free' },
      ];
      mockOrderBy.mockResolvedValueOnce(fakeOrgs);

      const { getAllOrgs } = await import('./admin.js');
      const result = await getAllOrgs();

      expect(result).toEqual(fakeOrgs);
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
    });
  });

  describe('getAllUsers', () => {
    it('returns users with org memberships grouped', async () => {
      const fakeUsers = [
        { id: 1, email: 'a@b.com', name: 'Alice', isPlatformAdmin: true, createdAt: new Date() },
        { id: 2, email: 'c@d.com', name: 'Bob', isPlatformAdmin: false, createdAt: new Date() },
      ];
      const fakeMemberships = [
        { userId: 1, orgId: 10, orgName: 'Acme', role: 'owner' },
        { userId: 2, orgId: 10, orgName: 'Acme', role: 'member' },
        { userId: 2, orgId: 20, orgName: 'Biz', role: 'owner' },
      ];

      // first call: users query chain
      mockOrderBy.mockResolvedValueOnce(fakeUsers);
      // second call: memberships query chain
      mockInnerJoin.mockReturnValueOnce(fakeMemberships);

      const { getAllUsers } = await import('./admin.js');
      const result = await getAllUsers();

      expect(result).toHaveLength(2);
      expect(result[0]!.orgs).toEqual([{ orgId: 10, orgName: 'Acme', role: 'owner' }]);
      expect(result[1]!.orgs).toEqual([
        { orgId: 10, orgName: 'Acme', role: 'member' },
        { orgId: 20, orgName: 'Biz', role: 'owner' },
      ]);
    });

    it('returns empty orgs array for users with no memberships', async () => {
      mockOrderBy.mockResolvedValueOnce([
        { id: 3, email: 'e@f.com', name: 'Charlie', isPlatformAdmin: false, createdAt: new Date() },
      ]);
      mockInnerJoin.mockReturnValueOnce([]);

      const { getAllUsers } = await import('./admin.js');
      const result = await getAllUsers();

      expect(result[0]!.orgs).toEqual([]);
    });
  });

  describe('getOrgDetail', () => {
    it('returns null for nonexistent org', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const { getOrgDetail } = await import('./admin.js');
      const result = await getOrgDetail(999);

      expect(result).toBeNull();
    });

    it('returns org with members, datasets, and subscription', async () => {
      const fakeOrg = { id: 1, name: 'Acme', slug: 'acme', createdAt: new Date() };
      const fakeMembers = [{ userId: 1, email: 'a@b.com', name: 'Alice', role: 'owner', isPlatformAdmin: false, joinedAt: new Date() }];
      const fakeDatasets = [{ id: 1, name: 'Q1 Revenue', isSeedData: false, createdAt: new Date() }];
      const fakeSub = { plan: 'pro', status: 'active' };

      // org query
      mockWhere.mockResolvedValueOnce([fakeOrg]);
      // members query
      mockWhere.mockResolvedValueOnce(fakeMembers);
      // datasets query
      mockWhere.mockResolvedValueOnce(fakeDatasets);
      // subscription query
      mockWhere.mockResolvedValueOnce([fakeSub]);

      const { getOrgDetail } = await import('./admin.js');
      const result = await getOrgDetail(1);

      expect(result).toEqual({
        ...fakeOrg,
        members: fakeMembers,
        datasets: fakeDatasets,
        subscription: fakeSub,
      });
    });
  });

  describe('getAdminStats', () => {
    it('returns aggregate counts plus month-to-date AI usage with estimated cost', async () => {
      mockFrom.mockResolvedValueOnce([{ value: 5 }]);
      mockFrom.mockResolvedValueOnce([{ value: 12 }]);
      mockWhere.mockResolvedValueOnce([{ value: 3 }]);
      mockGetMonthToDateAiUsage.mockResolvedValueOnce({
        inputTokens: 500_000,
        outputTokens: 100_000,
        requestCount: 42,
      });

      const { getAdminStats } = await import('./admin.js');
      const result = await getAdminStats();

      expect(result.totalOrgs).toBe(5);
      expect(result.totalUsers).toBe(12);
      expect(result.proSubscribers).toBe(3);
      expect(result.aiUsage.inputTokens).toBe(500_000);
      expect(result.aiUsage.outputTokens).toBe(100_000);
      expect(result.aiUsage.requestCount).toBe(42);
      // 500k × $3/M + 100k × $15/M = $1.50 + $1.50 = $3.00 (Sonnet 4.5 default)
      expect(result.aiUsage.estimatedCostUsd).toBeCloseTo(3.0, 2);
    });

    it('returns $0.00 cost when no AI requests happened this month', async () => {
      mockFrom.mockResolvedValueOnce([{ value: 0 }]);
      mockFrom.mockResolvedValueOnce([{ value: 0 }]);
      mockWhere.mockResolvedValueOnce([{ value: 0 }]);
      mockGetMonthToDateAiUsage.mockResolvedValueOnce({
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
      });

      const { getAdminStats } = await import('./admin.js');
      const result = await getAdminStats();

      expect(result.aiUsage.estimatedCostUsd).toBe(0);
    });
  });
});
