import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '../schema.js';

// SQL-shape test rig: Drizzle backed by a real postgres-js tag (lazy
// connection, never opens a socket because we only call `.toSQL()`). Drizzle
// requires the tag to expose `.parsers`, so a hand-rolled fake doesn't work.
// AC #14b asks for "fixture db" coverage; without infra-grade Postgres in
// tests, capturing the actual emitted SQL is the closest behavioral check
// possible. A regression in any predicate (Pro tier, active subscription,
// recency, opted-in member) shows up as a missing or changed clause in the
// captured SQL string.
const inertClient = postgres('postgres://test:test@localhost:1/test', {
  max: 0,
  fetch_types: false,
  prepare: false,
});
const inertDb = drizzle(inertClient, { schema });

// Execute-path test rig: chain mocks let us assert post-query JS logic
// (.filter narrowing, return shape) without needing a Drizzle round-trip.
const mockEligibilityLimit = vi.fn<(n: number) => Promise<unknown[]>>();
const mockEligibilityOrderBy = vi.fn(() => ({ limit: mockEligibilityLimit }));
const mockEligibilityWhere = vi.fn(() => ({ orderBy: mockEligibilityOrderBy }));
const mockEligibilityInnerJoinDatasets = vi.fn(() => ({ where: mockEligibilityWhere }));
const mockEligibilityInnerJoinSubs = vi.fn(() => ({ innerJoin: mockEligibilityInnerJoinDatasets }));
const mockEligibilityFrom = vi.fn(() => ({ innerJoin: mockEligibilityInnerJoinSubs }));

const mockRecipientsWhere = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
const mockRecipientsLeftJoin = vi.fn(() => ({ where: mockRecipientsWhere }));
const mockRecipientsInnerJoin = vi.fn(() => ({ leftJoin: mockRecipientsLeftJoin }));
const mockRecipientsFrom = vi.fn(() => ({ innerJoin: mockRecipientsInnerJoin }));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {
    select: (arg?: Record<string, unknown>) => {
      // The eligibility builder calls `.select({ x: <sql> })` for the EXISTS
      // subquery. The recipients builder selects `{ userId, email, name }`.
      // The main eligibility query selects `{ id, name, activeDatasetId, businessProfile }`.
      if (arg && Object.keys(arg).length === 1 && 'x' in arg) {
        return { from: () => ({ leftJoin: () => ({ where: vi.fn() }) }) };
      }
      if (arg && 'userId' in arg && 'email' in arg) {
        return { from: mockRecipientsFrom };
      }
      return { from: mockEligibilityFrom };
    },
  },
}));

const { findEligibleOrgs, findOrgRecipients, buildEligibilityQuery } =
  await import('./digestEligibility.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildEligibilityQuery: SQL shape (AC #2, AC #14b)', () => {
  it('emits all five required predicates in the WHERE clause', () => {
    const { sql } = buildEligibilityQuery(inertDb as never).toSQL();

    // Every spec-required filter must appear in the emitted SQL. A regression
    // dropping any one of these silently leaks digests to ineligible orgs.
    expect(sql).toMatch(/"subscriptions"\."status"\s*=\s*\$/);
    expect(sql).toMatch(/"subscriptions"\."plan"\s*=\s*\$/);
    expect(sql).toMatch(/"orgs"\."active_dataset_id"\s+is not null/i);
    expect(sql).toMatch(/"datasets"\."created_at"\s*>=\s*now\(\)\s*-\s*interval\s*'30 days'/);
    // Member-opted-in EXISTS subquery checks digest_preferences.cadence
    expect(sql.toLowerCase()).toContain('exists');
    expect(sql).toMatch(/"digest_preferences"\."cadence"/);
  });

  it('binds the literal values "active" and "pro", not their negations', () => {
    const { params } = buildEligibilityQuery(inertDb as never).toSQL();
    // params is the param array Drizzle would send to postgres. Both literals
    // must be present so a typo (e.g., "Active", "PRO") fails the test.
    expect(params).toContain('active');
    expect(params).toContain('pro');
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
    // First page WHERE has 5 conditions; second page has 6. Count $-bound
    // params as a proxy for predicate count: cursor adds one binding.
    expect(second.params.length).toBe(first.params.length + 1);
  });

  it('limits to the supplied pageSize, defaulting to 500', () => {
    const def = buildEligibilityQuery(inertDb as never).toSQL();
    const small = buildEligibilityQuery(inertDb as never, undefined, 25).toSQL();
    expect(def.sql).toMatch(/limit\s+\$/i);
    expect(def.params).toContain(500);
    expect(small.params).toContain(25);
  });

  it('joins the three required tables exactly once each in the outer FROM', () => {
    const { sql } = buildEligibilityQuery(inertDb as never).toSQL();
    const innerJoinSubs = (sql.match(/inner join\s+"subscriptions"/gi) ?? []).length;
    const innerJoinDatasets = (sql.match(/inner join\s+"datasets"/gi) ?? []).length;
    expect(innerJoinSubs).toBe(1);
    expect(innerJoinDatasets).toBe(1);
  });

  it('rejects orgs whose only opted-in members have cadence=off', () => {
    // The EXISTS subquery selects `1 from user_orgs LEFT JOIN
    // digest_preferences WHERE cadence IS NULL OR cadence <> 'off'`. If
    // the inequality predicate is dropped, off-cadence orgs leak through.
    // Drizzle emits <> rather than != for the ne() helper; both are valid
    // SQL inequality operators.
    const { sql, params } = buildEligibilityQuery(inertDb as never).toSQL();
    expect(sql).toMatch(/"digest_preferences"\."cadence"\s+is\s+null/i);
    expect(sql).toMatch(/"digest_preferences"\."cadence"\s*(?:<>|!=)\s*\$/);
    expect(params).toContain('off');
  });
});

describe('findEligibleOrgs: execute path', () => {
  it('returns rows shaped as EligibleOrg with non-null activeDatasetId', async () => {
    mockEligibilityLimit.mockResolvedValueOnce([
      { id: 10, name: 'Acme', activeDatasetId: 100, businessProfile: { businessType: 'agency' } },
      { id: 9, name: 'Beta', activeDatasetId: 200, businessProfile: null },
    ]);

    const rows = await findEligibleOrgs();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 10, activeDatasetId: 100 });
    expect(rows[1]).toMatchObject({ id: 9, activeDatasetId: 200 });
  });

  it('filters out rows with null activeDatasetId (defensive narrowing)', async () => {
    mockEligibilityLimit.mockResolvedValueOnce([
      { id: 10, name: 'Acme', activeDatasetId: 100, businessProfile: null },
      { id: 9, name: 'Beta', activeDatasetId: null, businessProfile: null },
    ]);

    const rows = await findEligibleOrgs();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(10);
  });

  it('passes the cursor through to the SQL where clause', async () => {
    mockEligibilityLimit.mockResolvedValueOnce([]);

    await findEligibleOrgs(50, 100);

    expect(mockEligibilityLimit).toHaveBeenCalledWith(100);
    expect(mockEligibilityWhere).toHaveBeenCalled();
  });

  it('defaults pageSize to 500', async () => {
    mockEligibilityLimit.mockResolvedValueOnce([]);

    await findEligibleOrgs();

    expect(mockEligibilityLimit).toHaveBeenCalledWith(500);
  });
});

describe('findOrgRecipients: execute path', () => {
  it('returns user rows shaped as DigestRecipient', async () => {
    mockRecipientsWhere.mockResolvedValueOnce([
      { userId: 1, email: 'a@x.com', name: 'Alice' },
      { userId: 2, email: 'b@x.com', name: 'Bob' },
    ]);

    const rows = await findOrgRecipients(42);

    expect(rows).toEqual([
      { userId: 1, email: 'a@x.com', name: 'Alice' },
      { userId: 2, email: 'b@x.com', name: 'Bob' },
    ]);
  });

  it('returns an empty array when no recipients match', async () => {
    mockRecipientsWhere.mockResolvedValueOnce([]);

    const rows = await findOrgRecipients(42);

    expect(rows).toEqual([]);
  });
});
