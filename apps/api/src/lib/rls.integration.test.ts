import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { subscriptionsQueries } from '../db/queries/index.js';
import { orgs, subscriptions, users } from '../db/schema.js';
import { db, dbAdmin, type DbTransaction } from './db.js';
import { withRlsContext, withUserRlsContext } from './rls.js';

// Real app_user/app_admin roles (docker/init.sql), no mocks -- proves the RLS
// policy itself blocks unscoped reads, not just the app's WHERE org_id clause.
// Lives under vitest.integration.config.ts so the default `pnpm test` (no
// Postgres service) never picks it up.

const futurePeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

type RlsContextSnapshot = { pid: number; orgId: string | null; isAdmin: string | null };

async function snapshotRlsContext(client: typeof db | DbTransaction): Promise<RlsContextSnapshot> {
  const [row] = await client.execute<{ pid: number; org_id: string | null; is_admin: string | null }>(
    sql`SELECT pg_backend_pid() AS pid, current_setting('app.current_org_id', true) AS org_id, current_setting('app.is_admin', true) AS is_admin`,
  );
  if (!row) throw new Error('RLS context probe returned no rows');
  return { pid: row.pid, orgId: row.org_id, isAdmin: row.is_admin };
}

type UserRlsContextSnapshot = { pid: number; userId: string | null; isAdmin: string | null };

async function snapshotUserRlsContext(client: typeof db | DbTransaction): Promise<UserRlsContextSnapshot> {
  const [row] = await client.execute<{ pid: number; user_id: string | null; is_admin: string | null }>(
    sql`SELECT pg_backend_pid() AS pid, current_setting('app.current_user_id', true) AS user_id, current_setting('app.is_admin', true) AS is_admin`,
  );
  if (!row) throw new Error('RLS context probe returned no rows');
  return { pid: row.pid, userId: row.user_id, isAdmin: row.is_admin };
}

let orgA: { id: number };
let orgB: { id: number };
let userA: { id: number };

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

  const emailA = `rls-test-user-a-${suffix}@example.com`;

  const [insertedUser] = await dbAdmin
    .insert(users)
    .values({ email: emailA, name: `RLS Test User A ${suffix}` })
    .returning({ id: users.id });
  if (!insertedUser) throw new Error('RLS test user insert returned no rows');
  userA = insertedUser;
});

afterAll(async () => {
  if (orgA) await dbAdmin.delete(orgs).where(eq(orgs.id, orgA.id));
  if (orgB) await dbAdmin.delete(orgs).where(eq(orgs.id, orgB.id));
  if (userA) await dbAdmin.delete(users).where(eq(users.id, userA.id));
});

describe('RLS context helpers against real Postgres', () => {
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

  it('does not leak SET LOCAL context past a committed transaction on a reused connection', async () => {
    const committed = await withRlsContext(orgA.id, true, snapshotRlsContext);
    const afterCommit = await snapshotRlsContext(db);

    // Same pid proves the bare probe reused the connection withRlsContext just
    // released back to the pool -- the only case a SET LOCAL leak could surface in.
    // A second withRlsContext call wouldn't prove anything here: it re-issues its
    // own SET LOCAL before this probe ever runs, so it'd read back its own fresh
    // values regardless of whether the prior transaction's context leaked.
    expect(afterCommit.pid).toBe(committed.pid);
    expect(committed.orgId).toBe(String(orgA.id));
    expect(committed.isAdmin).toBe('true');
    // Postgres resets an already-referenced custom GUC to '' (not NULL) once its
    // LOCAL scope ends -- confirmed empirically against a real postgres:18.2 instance.
    expect(afterCommit.orgId).toBe('');
    expect(afterCommit.isAdmin).toBe('');
  });

  it('does not leak withUserRlsContext SET LOCAL context past a committed transaction on a reused connection', async () => {
    // Same reused-connection, bare-probe design as the withRlsContext leak test
    // above -- see its comments for why pid equality and the '' GUC reset matter.
    const committed = await withUserRlsContext(userA.id, true, snapshotUserRlsContext);
    const afterCommit = await snapshotUserRlsContext(db);

    expect(afterCommit.pid).toBe(committed.pid);
    expect(committed.userId).toBe(String(userA.id));
    expect(committed.isAdmin).toBe('true');
    expect(afterCommit.userId).toBe('');
    expect(afterCommit.isAdmin).toBe('');
  });
});
