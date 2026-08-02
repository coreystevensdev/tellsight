import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { subscriptionsQueries } from '../db/queries/index.js';
import { orgs, subscriptions } from '../db/schema.js';
import { db, dbAdmin } from './db.js';
import { withRlsContext } from './rls.js';

// Real app_user/app_admin roles (docker/init.sql), no mocks -- proves the RLS
// policy itself blocks unscoped reads, not just the app's WHERE org_id clause.
// Lives under vitest.integration.config.ts so the default `pnpm test` (no
// Postgres service) never picks it up.

const futurePeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let orgA: { id: number };
let orgB: { id: number };

beforeAll(async () => {
  const suffix = Date.now();
  const slugA = `rls-test-org-a-${suffix}`;
  const slugB = `rls-test-org-b-${suffix}`;

  const inserted = await dbAdmin
    .insert(orgs)
    .values([
      { name: 'RLS Test Org A', slug: slugA },
      { name: 'RLS Test Org B', slug: slugB },
    ])
    .returning({ id: orgs.id, slug: orgs.slug });
  // Postgres doesn't guarantee multi-row RETURNING order matches the VALUES
  // list, key off slug instead of array position.
  orgA = inserted.find((row) => row.slug === slugA)!;
  orgB = inserted.find((row) => row.slug === slugB)!;

  await dbAdmin.insert(subscriptions).values([
    { orgId: orgA.id, status: 'active', plan: 'pro', agentEnabled: true, currentPeriodEnd: futurePeriodEnd },
    { orgId: orgB.id, status: 'active', plan: 'pro', agentEnabled: false, currentPeriodEnd: futurePeriodEnd },
  ]);
});

afterAll(async () => {
  if (orgA) await dbAdmin.delete(orgs).where(eq(orgs.id, orgA.id));
  if (orgB) await dbAdmin.delete(orgs).where(eq(orgs.id, orgB.id));
});

describe('withRlsContext against real Postgres', () => {
  it('getActiveTier resolves pro when the RLS context matches the org', async () => {
    const tier = await withRlsContext(orgA.id, false, (tx) => subscriptionsQueries.getActiveTier(orgA.id, tx));
    expect(tier).toBe('pro');
  });

  it('getActiveTier fails closed to free when no RLS context is set, even though the row exists', async () => {
    const tier = await subscriptionsQueries.getActiveTier(orgA.id, db);
    expect(tier).toBe('free');
  });

  it('getAgentEnabled resolves true when the RLS context matches the org', async () => {
    const enabled = await withRlsContext(orgA.id, false, (tx) => subscriptionsQueries.getAgentEnabled(orgA.id, tx));
    expect(enabled).toBe(true);
  });

  it('getAgentEnabled fails closed to false when no RLS context is set, even though the row exists', async () => {
    const enabled = await subscriptionsQueries.getAgentEnabled(orgA.id, db);
    expect(enabled).toBe(false);
  });

  it('enforces tenant isolation at the database level with no WHERE filter in the query', async () => {
    const rows = await withRlsContext(orgA.id, false, (tx) => tx.select().from(subscriptions));
    expect(rows.map((row) => row.orgId)).toEqual([orgA.id]);
  });

  it('lets app_admin bypass RLS with no context set', async () => {
    const rows = await dbAdmin.select().from(subscriptions).where(eq(subscriptions.orgId, orgB.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.orgId).toBe(orgB.id);
  });
});
