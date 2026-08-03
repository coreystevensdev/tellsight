import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../schema.js';

// SQL-shape test rig, same precedent as alertEligibility.test.ts: a lazy
// postgres-js tag that never opens a socket, only `.toSQL()` gets called
// against it.
const inertClient = postgres('postgres://test:test@localhost:1/test', {
  max: 0,
  fetch_types: false,
  prepare: false,
});
const inertDb = drizzle(inertClient, { schema });

const mockLimit = vi.fn<(n: number) => Promise<unknown[]>>();
const mockOrderBy = vi.fn(() => ({ limit: mockLimit }));
const mockWhere = vi.fn(() => ({ orderBy: mockOrderBy }));
const mockInnerJoin = vi.fn(() => ({ where: mockWhere }));
const mockFrom = vi.fn(() => ({ innerJoin: mockInnerJoin }));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {
    select: () => ({ from: mockFrom }),
  },
}));

const { findEligibleOrgs, buildEligibilityQuery } = await import('./agentEligibility.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEligibilityQuery: SQL shape', () => {
  it('emits all required predicates in the WHERE clause', () => {
    const { sql } = buildEligibilityQuery(inertDb as never).toSQL();

    expect(sql).toMatch(/"subscriptions"\."status"\s*=\s*\$/);
    expect(sql).toMatch(/"subscriptions"\."plan"\s*=\s*\$/);
    expect(sql).toMatch(/"subscriptions"\."agent_enabled"\s*=\s*\$/);
    expect(sql).toMatch(/"orgs"\."active_dataset_id"\s+is not null/i);
  });

  it('binds the literal values "active", "pro", and true', () => {
    const { params } = buildEligibilityQuery(inertDb as never).toSQL();
    expect(params).toContain('active');
    expect(params).toContain('pro');
    expect(params).toContain(true);
  });

  it('ORs the active status against a canceled-with-grace-period branch', () => {
    const { sql, params } = buildEligibilityQuery(inertDb as never).toSQL();

    // both status branches bind separately, active OR (canceled AND currentPeriodEnd > now)
    const statusBindings = (sql.match(/"subscriptions"\."status"\s*=\s*\$/g) ?? []).length;
    expect(statusBindings).toBe(2);
    expect(params).toContain('canceled');
    expect(sql).toMatch(/"subscriptions"\."current_period_end"\s*>\s*\$/);
    expect(sql).toMatch(/"subscriptions"\."current_period_end"\s+is not null/i);

    // the two status branches must be OR'd, not AND'd -- flattening them into
    // the same and(...) would make "status = 'active' and status = 'canceled'"
    // always false and silently zero out the whole sweep
    expect(sql).toMatch(/"subscriptions"\."status"\s*=\s*\$\d+\s+or\s+\(/i);
  });

  it('emits a DESC keyset cursor on orgs.id when cursor is supplied', () => {
    const { sql, params } = buildEligibilityQuery(inertDb as never, 100, 50).toSQL();
    expect(sql).toMatch(/order by\s+"orgs"\."id"\s+desc/i);
    expect(sql).toMatch(/"orgs"\."id"\s*<\s*\$/);
    expect(params).toContain(100);
  });

  it('omits the cursor predicate on the first page', () => {
    const first = buildEligibilityQuery(inertDb as never).toSQL();
    const second = buildEligibilityQuery(inertDb as never, 42).toSQL();
    expect(second.params.length).toBe(first.params.length + 1);
  });

  it('limits to the supplied pageSize, defaulting to 500', () => {
    const def = buildEligibilityQuery(inertDb as never).toSQL();
    const small = buildEligibilityQuery(inertDb as never, undefined, 25).toSQL();
    expect(def.sql).toMatch(/limit\s+\$/i);
    expect(def.params).toContain(500);
    expect(small.params).toContain(25);
  });

  it('joins subscriptions exactly once in the outer FROM', () => {
    const { sql } = buildEligibilityQuery(inertDb as never).toSQL();
    const innerJoinSubs = (sql.match(/inner join\s+"subscriptions"/gi) ?? []).length;
    expect(innerJoinSubs).toBe(1);
  });
});

describe('findEligibleOrgs: execute path', () => {
  it('returns rows shaped as EligibleOrg with non-null activeDatasetId', async () => {
    mockLimit.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: 200 },
    ]);

    const rows = await findEligibleOrgs();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 10, activeDatasetId: 100 });
  });

  it('filters out rows with null activeDatasetId (defensive narrowing)', async () => {
    mockLimit.mockResolvedValueOnce([
      { id: 10, activeDatasetId: 100 },
      { id: 9, activeDatasetId: null },
    ]);

    const rows = await findEligibleOrgs();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(10);
  });

  it('passes the cursor and pageSize through to the SQL builder', async () => {
    mockLimit.mockResolvedValueOnce([]);

    await findEligibleOrgs(50, 100);

    expect(mockLimit).toHaveBeenCalledWith(100);
    expect(mockWhere).toHaveBeenCalled();
  });

  it('defaults pageSize to 500', async () => {
    mockLimit.mockResolvedValueOnce([]);

    await findEligibleOrgs();

    expect(mockLimit).toHaveBeenCalledWith(500);
  });
});
