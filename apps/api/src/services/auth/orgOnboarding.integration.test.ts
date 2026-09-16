import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import * as datasetsQueries from '../../db/queries/datasets.js';
import * as dataRowsQueries from '../../db/queries/dataRows.js';
import { orgs, users } from '../../db/schema.js';
import { dbAdmin } from '../../lib/db.js';
import { withRlsContext } from '../../lib/rls.js';
import { createOwnerOrgForUser } from './orgOnboarding.js';

// The unit tests mock the db client, so they can prove seedDemoData issues the
// right calls but not that the rows land somewhere the owner can read them.
// Sign-up writes through dbAdmin into an org the caller has no RLS session for,
// which is the shape that has failed silently here before: a write that RLS
// accepts and a read that returns nothing.

let orgId: number;
let userId: number;

beforeAll(async () => {
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `onboarding-${Date.now()}@example.com`, name: 'Dana Onboarding' })
    .returning({ id: users.id });
  if (!user) throw new Error('test user insert returned no rows');
  userId = user.id;

  const { org } = await createOwnerOrgForUser(userId, `Onboarding ${Date.now()}`);
  orgId = org.id;
});

afterAll(async () => {
  if (orgId) await dbAdmin.delete(orgs).where(eq(orgs.id, orgId));
  if (userId) await dbAdmin.delete(users).where(eq(users.id, userId));
});

describe('a new org after sign-up', () => {
  it('has demo rows its owner can read under their own RLS context', async () => {
    const { datasets, rowCount } = await withRlsContext(orgId, false, async (tx) => {
      const ds = await datasetsQueries.getDatasetsByOrg(orgId, tx);
      const count = ds[0] ? await dataRowsQueries.getRowCount(orgId, ds[0].id, tx) : 0;
      return { datasets: ds, rowCount: count };
    });

    expect(datasets).toHaveLength(1);
    expect(datasets[0]?.isSeedData).toBe(true);
    expect(rowCount).toBeGreaterThan(200);
  });

  it('reports seed_only, which is what puts the sample-data banner up', async () => {
    const state = await withRlsContext(orgId, false, (tx) =>
      datasetsQueries.getUserOrgDemoState(orgId, tx),
    );

    expect(state).toBe('seed_only');
  });

  it('does not count the demo data against the upload quota', async () => {
    const count = await withRlsContext(orgId, false, (tx) =>
      datasetsQueries.getNonSeedDatasetCount(orgId, tx),
    );

    expect(count).toBe(0);
  });

  // persistUpload has always deleted seed datasets first. Until sign-up seeded
  // anything that call had nothing to delete, so this is the first test that
  // makes it do work.
  it('swaps the demo data out for the first real upload', async () => {
    const result = await withRlsContext(orgId, false, (tx) =>
      datasetsQueries.persistUpload(orgId, userId, 'january.csv', [
        { category: 'Revenue', parentCategory: 'Income', date: new Date('2026-01-05'), amount: '1200.00', label: null, metadata: null },
      ], tx),
    );

    expect(result.demoState).toBe('user_only');

    const remaining = await withRlsContext(orgId, false, (tx) =>
      datasetsQueries.getDatasetsByOrg(orgId, tx),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.isSeedData).toBe(false);
    expect(remaining[0]?.name).toBe('january.csv');
  });
});
