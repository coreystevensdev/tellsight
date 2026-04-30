import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn() as ReturnType<typeof vi.fn> & { _resultPromise: Promise<unknown[]> };

vi.mock('../../lib/db.js', () => ({
  db: {
    select: () => {
      mockSelect();
      return { from: (...args: unknown[]) => { mockFrom(...args); return { where: (...wArgs: unknown[]) => { mockWhere(...wArgs); return { limit: (n: number) => { mockLimit(n); return mockLimit._resultPromise; } }; } }; } };
    },
  },
}));

vi.mock('../schema.js', () => ({
  subscriptions: {
    orgId: 'org_id',
    status: 'status',
    currentPeriodEnd: 'current_period_end',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
  or: (...args: unknown[]) => ({ or: args }),
  isNull: (a: unknown) => ({ isNull: a }),
  isNotNull: (a: unknown) => ({ isNotNull: a }),
}));

describe('getActiveTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pro when active subscription exists', async () => {
    mockLimit._resultPromise = Promise.resolve([{ id: 1 }]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('pro');
  });

  it('returns free when no subscription rows', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('returns free on query error (table does not exist)', async () => {
    mockLimit._resultPromise = Promise.reject(new Error('relation "subscriptions" does not exist'));

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('returns pro for active subscription with null currentPeriodEnd (fresh checkout)', async () => {
    // fresh checkout sets currentPeriodEnd: null, the isNull branch keeps access
    mockLimit._resultPromise = Promise.resolve([{ id: 1, status: 'active', currentPeriodEnd: null }]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('pro');
  });

  it('returns pro for canceled subscription within period', async () => {
    // canceled but period hasn't ended yet, query's OR branch matches
    mockLimit._resultPromise = Promise.resolve([{ id: 1, status: 'canceled', currentPeriodEnd: new Date(Date.now() + 86400000) }]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('pro');
  });

  it('returns free for canceled subscription past period end', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('returns free for canceled subscription with null currentPeriodEnd', async () => {
    // edge case: shouldn't happen but defensively returns nothing
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  // Story 5.3, documents expected behavior for statuses that return free by exclusion.
  // These test the "empty result → free" mapping. Actual WHERE clause filtering is
  // verified structurally in the "WHERE clause includes canceled-within-period branch" test
  // below, unit mocks can't exercise real Drizzle query logic.
  it('returns free for expired subscription', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('returns free for past_due subscription', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('returns free for canceled subscription with period in the past', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    const tier = await getActiveTier(1);

    expect(tier).toBe('free');
  });

  it('WHERE clause includes canceled-within-period branch', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    await getActiveTier(42);

    // the WHERE clause (2nd element of the `and()` array) must include an `or` with both
    // active and canceled branches, prevents silent removal of the canceled access path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whereArg = mockWhere.mock.calls[0]![0] as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orClause = whereArg[1] as any;
    expect(orClause).toHaveProperty('or');

    const branches = orClause.or;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusValues = branches.map((b: any) => {
      const eqEntry = Array.isArray(b) ? b[0] : b;
      return eqEntry?.eq?.[1];
    });
    expect(statusValues).toContain('active');
    expect(statusValues).toContain('canceled');
  });
});
