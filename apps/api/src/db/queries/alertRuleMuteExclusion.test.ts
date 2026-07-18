import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// getEnabledByOrgIdsForEvaluation's existing test suite (alertRules.test.ts)
// mocks drizzle-orm's and/or/isNull/lte entirely, so it only proves the where
// clause was called, never what it actually excludes. This file uses the real
// drizzle-orm query builder and the real schema, capturing the SQL condition
// object the query passes to .where() and rendering it back to text via
// PgDialect (no live connection needed) to assert the mute-exclusion
// semantics the epic AC depends on.

const mockWhere = vi.fn();

vi.mock('../../lib/db.js', () => ({
  db: {},
  dbAdmin: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          mockWhere(condition);
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

const { getEnabledByOrgIdsForEvaluation } = await import('./alertRules.js');
const { dbAdmin } = await import('../../lib/db.js');

const dialect = new PgDialect();

beforeEach(() => vi.clearAllMocks());

describe('getEnabledByOrgIdsForEvaluation, real WHERE-clause semantics', () => {
  it('excludes rows where mute_until is a future timestamp', async () => {
    await getEnabledByOrgIdsForEvaluation([10, 20], dbAdmin as never);

    const condition = mockWhere.mock.calls[0]![0];
    const { sql, params } = dialect.sqlToQuery(condition as never);

    expect(sql).toContain('"alert_rules"."mute_until" is null or "alert_rules"."mute_until" <=');
    expect(sql).toContain('"alert_rules"."enabled" =');
    expect(sql).toContain('"alert_rules"."deleted_at" is null');
    expect(sql).toContain('"alert_rules"."org_id" in');
    expect(params).toEqual(expect.arrayContaining([10, 20, true]));
  });

  it('binds a mute_until cutoff of "now" rather than a fixed constant', async () => {
    const before = Date.now();
    await getEnabledByOrgIdsForEvaluation([10], dbAdmin as never);
    const after = Date.now();

    const condition = mockWhere.mock.calls[0]![0];
    const { params } = dialect.sqlToQuery(condition as never);
    // PgDialect serializes Date params to ISO strings when rendering the query.
    const cutoff = params.find((p): p is string => typeof p === 'string' && !Number.isNaN(Date.parse(p)));

    expect(cutoff).toBeDefined();
    const cutoffMs = Date.parse(cutoff!);
    expect(cutoffMs).toBeGreaterThanOrEqual(before);
    expect(cutoffMs).toBeLessThanOrEqual(after);
  });
});
