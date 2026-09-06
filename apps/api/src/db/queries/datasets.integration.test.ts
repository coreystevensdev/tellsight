import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import type { NormalizedRow } from '../../services/dataIngestion/normalizer.js';
import { orgs, users, datasets, dataRows, aiSummaries, milestoneAwards } from '../schema.js';
import {
  getDatasetListWithCounts,
  deleteDataset,
  getNonSeedDatasetCount,
  lockOrgForDatasetQuota,
  persistUpload,
  getUserOrgDemoState,
} from './datasets.js';
import { awardMilestone } from './milestoneAwards.js';

// Real Postgres, no mocks -- the datasets-manage.test.ts route test mocks
// getDatasetListWithCounts entirely, so it can't catch a query-shape bug
// like uploadedBy coming back as a bare user id instead of {id, name}.

const createdOrgs: number[] = [];
const createdUsers: number[] = [];

// Deleting the org cascades to its datasets; users are set null on the dataset
// and have to go separately. Without this the suite leaves orgs behind on every
// run, which matters locally and to any test that counts rows.
afterAll(async () => {
  if (createdOrgs.length) {
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
  if (createdUsers.length) {
    await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
  }
});

async function seedOrg(label: string): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `datasets-list-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  return org!.id;
}

describe('getDatasetListWithCounts against real Postgres', () => {
  it('resolves uploadedBy to {id, name}, not the raw user id column', async () => {
    const orgId = await seedOrg('uploader-shape');
    const [user] = await dbAdmin
      .insert(users)
      .values({ email: `uploader-${Date.now()}@example.com`, name: 'Dana Uploader' })
      .returning({ id: users.id });
    createdUsers.push(user!.id);

    await dbAdmin.insert(datasets).values({ orgId, name: 'Q1 Financials', uploadedBy: user!.id });

    const [result] = await getDatasetListWithCounts(orgId, null, dbAdmin);

    expect(result?.uploadedBy).toEqual({ id: user!.id, name: 'Dana Uploader' });
  });

  // Every other test here seeds a fresh org holding one dataset, which makes the
  // org filter invisible: results come back newest-first, so index 0 is the row
  // the test just inserted whether or not the query scopes by org. This one
  // inserts a newer dataset somewhere else, so dropping the scope changes what
  // comes back. It did not before: removing the org predicate left 2,469 unit
  // and 100 integration tests green while every org read every org's list.
  it('returns only the caller org datasets, not the newest row overall', async () => {
    const mine = await seedOrg('scope-mine');
    const theirs = await seedOrg('scope-theirs');

    await dbAdmin.insert(datasets).values({ orgId: mine, name: 'Mine' });
    await dbAdmin.insert(datasets).values({ orgId: theirs, name: 'Theirs, and newer' });

    const rows = await getDatasetListWithCounts(mine, null, dbAdmin);

    expect(rows.map((r) => r.name)).toEqual(['Mine']);
  });

  // Seed rows belong to demo mode, not to the org's own file list. Inserted last
  // so it sorts first, which is where an unfiltered query would surface it.
  it('leaves seed datasets out of the org list', async () => {
    const orgId = await seedOrg('scope-seed');
    await dbAdmin.insert(datasets).values({ orgId, name: 'Uploaded by hand' });
    await dbAdmin.insert(datasets).values({ orgId, name: 'Demo data', isSeedData: true });

    const rows = await getDatasetListWithCounts(orgId, null, dbAdmin);

    expect(rows.map((r) => r.name)).toEqual(['Uploaded by hand']);
  });

  it('returns uploadedBy as null when the dataset has no uploader', async () => {
    const orgId = await seedOrg('no-uploader');
    await dbAdmin.insert(datasets).values({ orgId, name: 'Imported via API' });

    const [result] = await getDatasetListWithCounts(orgId, null, dbAdmin);

    expect(result?.uploadedBy).toBeNull();
  });
});

// deleteDataset excludes seed data, and nothing asserted it: removing
// ne(isSeedData, true) left the unit and integration suites green. Seed datasets
// become deletable, which strands the demo-mode state machine for that org,
// since it distinguishes seed_only from user_only by their presence.
describe('deleteDataset against real Postgres', () => {
  async function insertDataset(orgId: number, isSeedData: boolean) {
    const [row] = await dbAdmin
      .insert(datasets)
      .values({ orgId, name: isSeedData ? 'Demo data' : 'Uploaded.csv', isSeedData })
      .returning({ id: datasets.id });
    return row!.id;
  }

  it('deletes an ordinary dataset', async () => {
    const orgId = await seedOrg('delete-ordinary');
    const id = await insertDataset(orgId, false);

    expect(await deleteDataset(orgId, id, dbAdmin)).toMatchObject({ id });
    const rows = await dbAdmin.select().from(datasets).where(eq(datasets.id, id));
    expect(rows).toHaveLength(0);
  });

  it('refuses to delete a seed dataset and leaves the row in place', async () => {
    const orgId = await seedOrg('delete-seed');
    const id = await insertDataset(orgId, true);

    expect(await deleteDataset(orgId, id, dbAdmin)).toBeNull();
    const rows = await dbAdmin.select().from(datasets).where(eq(datasets.id, id));
    expect(rows).toHaveLength(1);
  });

  it('refuses to delete another org dataset', async () => {
    const mine = await seedOrg('delete-mine');
    const theirs = await seedOrg('delete-theirs');
    const id = await insertDataset(theirs, false);

    expect(await deleteDataset(mine, id, dbAdmin)).toBeNull();
    expect(await dbAdmin.select().from(datasets).where(eq(datasets.id, id))).toHaveLength(1);
  });
});

// awardMilestone's whole dedup is the onConflictDoNothing target. Removing it
// left every suite green, and a second award for the same org and kind would
// then raise a unique violation rather than being ignored, which is what the
// caller relies on to stay idempotent under retry.
describe('awardMilestone against real Postgres', () => {
  it('ignores a repeat award for the same org and kind', async () => {
    const orgId = await seedOrg('milestone-dedup');
    const input = { orgId, kind: 'first_profitable_month' as const, datasetId: null };

    await awardMilestone(input, dbAdmin);
    await expect(awardMilestone(input, dbAdmin)).resolves.toBeUndefined();

    const rows = await dbAdmin
      .select()
      .from(milestoneAwards)
      .where(and(eq(milestoneAwards.orgId, orgId), eq(milestoneAwards.kind, 'first_profitable_month')));
    expect(rows).toHaveLength(1);
  });

  it('still records a different kind for the same org', async () => {
    const orgId = await seedOrg('milestone-kinds');

    await awardMilestone({ orgId, kind: 'first_profitable_month', datasetId: null }, dbAdmin);
    await awardMilestone({ orgId, kind: 'first_break_even', datasetId: null }, dbAdmin);

    const rows = await dbAdmin.select().from(milestoneAwards).where(eq(milestoneAwards.orgId, orgId));
    expect(rows).toHaveLength(2);
  });
});

// The upload path counts an org's datasets and then inserts, which is a race no
// serial test can see: under READ COMMITTED two callers both read the same
// under-limit count before either commits, and both insert. Demonstrated at 21
// rows for a limit of 20 before the advisory lock went in.
//
// This models the route's shape rather than calling it, because the race is in
// the transaction boundary and the route wraps it in HTTP, auth and RLS that
// have nothing to do with the failure.
describe('dataset quota under concurrency', () => {
  const LIMIT = 20;

  async function insertN(orgId: number, n: number) {
    for (let i = 0; i < n; i += 1) {
      await dbAdmin.insert(datasets).values({ orgId, name: `seeded-${i}.csv`, isSeedData: false });
    }
  }

  /** One upload attempt, shaped exactly like the route's withRlsContext block. */
  async function attemptUpload(orgId: number, opts: { lock: boolean }) {
    return dbAdmin.transaction(async (tx) => {
      if (opts.lock) await lockOrgForDatasetQuota(orgId, tx);

      const count = await getNonSeedDatasetCount(orgId, tx);
      if (count >= LIMIT) return 'rejected' as const;

      // A real upload does more work between the count and the insert, which is
      // what widens the window. This stands in for it.
      await tx.execute(sql`select pg_sleep(0.1)`);
      await tx.insert(datasets).values({ orgId, name: 'concurrent.csv', isSeedData: false });
      return 'accepted' as const;
    });
  }

  it('admits only one of two concurrent uploads at the ceiling', async () => {
    const orgId = await seedOrg('quota-race');
    await insertN(orgId, LIMIT - 1);

    const outcomes = await Promise.all([
      attemptUpload(orgId, { lock: true }),
      attemptUpload(orgId, { lock: true }),
    ]);

    expect(outcomes.filter((o) => o === 'accepted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'rejected')).toHaveLength(1);
    expect(await getNonSeedDatasetCount(orgId, dbAdmin)).toBe(LIMIT);
  });

  // The same scenario without the lock, proving the test can tell the two apart
  // rather than passing because concurrency never actually happened.
  it('would exceed the ceiling without the lock', async () => {
    const orgId = await seedOrg('quota-race-unlocked');
    await insertN(orgId, LIMIT - 1);

    const outcomes = await Promise.all([
      attemptUpload(orgId, { lock: false }),
      attemptUpload(orgId, { lock: false }),
    ]);

    expect(outcomes.filter((o) => o === 'accepted')).toHaveLength(2);
    expect(await getNonSeedDatasetCount(orgId, dbAdmin)).toBe(LIMIT + 1);
  });

  it('still admits an upload when the org is under the ceiling', async () => {
    const orgId = await seedOrg('quota-under');
    await insertN(orgId, 2);

    expect(await attemptUpload(orgId, { lock: true })).toBe('accepted');
    expect(await getNonSeedDatasetCount(orgId, dbAdmin)).toBe(3);
  });
});

// routes/datasets.test.ts mocks persistUpload wholesale and no integration test
// existed, so nothing in the repo executed its body. Deleting markStale from it
// left all 2,459 api tests green, and that call is the entire "AI summary cache
// goes stale on upload" decision: without it a user uploads fresh data and keeps
// reading last week's interpretation, with nothing to indicate it is old.
describe('persistUpload against real Postgres', () => {
  // uploadedBy carries a foreign key, so the id has to be a real row.
  let uploaderId: number;

  beforeAll(async () => {
    const [user] = await dbAdmin
      .insert(users)
      .values({ email: `persist-uploader-${Date.now()}@test.local`, name: 'Uploader' })
      .returning({ id: users.id });
    uploaderId = user!.id;
    createdUsers.push(uploaderId);
  });

  const rows: NormalizedRow[] = [
    { category: 'Sales', parentCategory: 'Income', date: new Date('2026-01-15'), amount: '1000.00', label: 'A', metadata: null },
    { category: 'Rent', parentCategory: 'Expenses', date: new Date('2026-01-16'), amount: '400.00', label: 'B', metadata: null },
  ];

  // persistUpload falls back to the RLS-scoped client when no transaction is
  // passed, and there is no RLS context here, so the insert would be refused by
  // policy. The route supplies one via withRlsContext; this supplies an admin
  // transaction, which exercises the same body and the same boundary.
  function upload(orgId: number, name: string, batch = rows) {
    return dbAdmin.transaction((tx) => persistUpload(orgId, uploaderId, name, batch, tx));
  }

  async function seedSummary(orgId: number, datasetId: number) {
    await dbAdmin.insert(aiSummaries).values({
      orgId,
      datasetId,
      content: 'Last week you were profitable.',
      audience: 'dashboard',
      promptVersion: 'v1.6',
    });
  }

  it('writes the dataset and every row in one call', async () => {
    const orgId = await seedOrg('persist-basic');

    const result = await upload(orgId, 'january.csv');

    expect(result.rowCount).toBe(2);
    const stored = await dbAdmin.select().from(dataRows).where(eq(dataRows.datasetId, result.datasetId));
    expect(stored).toHaveLength(2);
  });

  // The cache invalidation. Marked stale, not deleted, so the old text stays
  // readable while the new one generates.
  it('marks an existing AI summary stale', async () => {
    const orgId = await seedOrg('persist-stale');
    const seed = await upload(orgId, 'first.csv');
    await seedSummary(orgId, seed.datasetId);

    await upload(orgId, 'second.csv');

    const [summary] = await dbAdmin.select().from(aiSummaries).where(eq(aiSummaries.orgId, orgId));
    expect(summary?.staleAt).not.toBeNull();
  });

  it('leaves another org summary alone', async () => {
    const mine = await seedOrg('persist-mine');
    const theirs = await seedOrg('persist-theirs');
    const theirDataset = await upload(theirs, 'theirs.csv');
    await seedSummary(theirs, theirDataset.datasetId);

    await upload(mine, 'mine.csv');

    const [summary] = await dbAdmin.select().from(aiSummaries).where(eq(aiSummaries.orgId, theirs));
    expect(summary?.staleAt).toBeNull();
  });

  // Option C: a real upload replaces the demo data rather than sitting beside
  // it, which is what moves the org out of seed_only.
  it('clears the org seed data and reports the new demo state', async () => {
    const orgId = await seedOrg('persist-seed');
    const [seeded] = await dbAdmin
      .insert(datasets)
      .values({ orgId, name: 'Demo data', isSeedData: true })
      .returning({ id: datasets.id });

    const result = await upload(orgId, 'real.csv');

    expect(await dbAdmin.select().from(datasets).where(eq(datasets.id, seeded!.id))).toHaveLength(0);
    expect(result.demoState).toBe('user_only');
    expect(await getUserOrgDemoState(orgId, dbAdmin)).toBe('user_only');
  });

  // One transaction, so a failure part-way leaves nothing behind. amount is
  // numeric(12,2), so a value past that ceiling makes insertBatch reject after
  // the dataset row already exists inside the same transaction. An empty batch
  // will not do it: insertBatch handles that case without erroring.
  it('rolls the dataset back when the row insert fails', async () => {
    const orgId = await seedOrg('persist-rollback');
    const before = await getNonSeedDatasetCount(orgId, dbAdmin);
    const overflows: NormalizedRow[] = [
      { category: 'Sales', parentCategory: 'Income', date: new Date('2026-01-15'), amount: '99999999999.99', label: 'too big', metadata: null },
    ];

    await expect(upload(orgId, 'broken.csv', overflows)).rejects.toThrow();

    expect(await getNonSeedDatasetCount(orgId, dbAdmin)).toBe(before);
  });
});
