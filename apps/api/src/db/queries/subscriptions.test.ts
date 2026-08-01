import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn() as ReturnType<typeof vi.fn> & { _resultPromise: Promise<unknown[]> };

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn() as ReturnType<typeof vi.fn> & { _resultPromise: Promise<unknown> };

vi.mock('../../lib/db.js', () => ({
  db: {
    select: () => {
      mockSelect();
      return { from: (...args: unknown[]) => { mockFrom(...args); return { where: (...wArgs: unknown[]) => { mockWhere(...wArgs); return { orderBy: (...oArgs: unknown[]) => { mockOrderBy(...oArgs); return { limit: (n: number) => { mockLimit(n); return mockLimit._resultPromise; } }; } }; } }; } };
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: (...vArgs: unknown[]) => { mockValues(...vArgs); return { onConflictDoUpdate: (...cArgs: unknown[]) => { mockOnConflictDoUpdate(...cArgs); return mockOnConflictDoUpdate._resultPromise; } }; } };
    },
  },
}));

vi.mock('../schema.js', () => ({
  subscriptions: {
    id: 'id',
    orgId: 'org_id',
    status: 'status',
    currentPeriodEnd: 'current_period_end',
    agentEnabled: 'agent_enabled',
    updatedAt: 'updated_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  desc: (a: unknown) => ({ desc: a }),
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

  it('orders by id descending for deterministic row selection', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getActiveTier } = await import('./subscriptions.js');
    await getActiveTier(1);

    expect(mockOrderBy).toHaveBeenCalledWith({ desc: 'id' });
  });
});

describe('updateAgentEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnConflictDoUpdate._resultPromise = Promise.resolve(undefined);
  });

  it('on first-time enable, inserts status=active/plan=pro so getAgentEnabled and buildEligibilityQuery both see the grant', async () => {
    const { updateAgentEnabled } = await import('./subscriptions.js');
    await updateAgentEnabled(1, true);

    expect(mockValues).toHaveBeenCalledWith({
      orgId: 1,
      status: 'active',
      plan: 'pro',
      agentEnabled: true,
    });
  });

  it('on first-time disable, inserts the inert status=inactive/plan=free defaults -- nothing to grant', async () => {
    const { updateAgentEnabled } = await import('./subscriptions.js');
    await updateAgentEnabled(2, false);

    expect(mockValues).toHaveBeenCalledWith({
      orgId: 2,
      status: 'inactive',
      plan: 'free',
      agentEnabled: false,
    });
  });

  it('on conflict-disable, only touches agentEnabled and updatedAt -- never status or plan, so a real paying subscription survives untouched', async () => {
    const { updateAgentEnabled } = await import('./subscriptions.js');
    await updateAgentEnabled(42, false);

    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'org_id',
        set: expect.objectContaining({ agentEnabled: false }),
      }),
    );
    const call = mockOnConflictDoUpdate.mock.calls[0]?.[0] as { set: Record<string, unknown> };
    expect(call.set).not.toHaveProperty('status');
    expect(call.set).not.toHaveProperty('plan');
  });

  it('on conflict-enable, also forces status=active/plan=pro -- a row stuck at a stale status (e.g. a prior disable, or a lapsed subscription) must not silently swallow the grant', async () => {
    const { updateAgentEnabled } = await import('./subscriptions.js');
    await updateAgentEnabled(42, true);

    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'org_id',
        set: expect.objectContaining({ agentEnabled: true, status: 'active', plan: 'pro' }),
      }),
    );
  });

  it('succeeds for an org with no prior subscription row (no throw)', async () => {
    const { updateAgentEnabled } = await import('./subscriptions.js');
    await expect(updateAgentEnabled(999, true)).resolves.toBeUndefined();
  });
});

describe('getAgentEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the active row has agentEnabled set', async () => {
    mockLimit._resultPromise = Promise.resolve([{ agentEnabled: true }]);

    const { getAgentEnabled } = await import('./subscriptions.js');
    expect(await getAgentEnabled(1)).toBe(true);
  });

  it('returns false when the active row has agentEnabled unset', async () => {
    mockLimit._resultPromise = Promise.resolve([{ agentEnabled: false }]);

    const { getAgentEnabled } = await import('./subscriptions.js');
    expect(await getAgentEnabled(1)).toBe(false);
  });

  it('returns false when no active row exists', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getAgentEnabled } = await import('./subscriptions.js');
    expect(await getAgentEnabled(1)).toBe(false);
  });

  it('fails closed on query error, not fails open', async () => {
    mockLimit._resultPromise = Promise.reject(new Error('relation "subscriptions" does not exist'));

    const { getAgentEnabled } = await import('./subscriptions.js');
    expect(await getAgentEnabled(1)).toBe(false);
  });

  it('orders by id descending for deterministic row selection', async () => {
    mockLimit._resultPromise = Promise.resolve([]);

    const { getAgentEnabled } = await import('./subscriptions.js');
    await getAgentEnabled(1);

    expect(mockOrderBy).toHaveBeenCalledWith({ desc: 'id' });
  });
});
