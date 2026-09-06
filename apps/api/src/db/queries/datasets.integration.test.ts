import { and, eq, inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, datasets } from '../schema.js';
import { getDatasetListWithCounts, deleteDataset } from './datasets.js';
import { awardMilestone } from './milestoneAwards.js';
import { milestoneAwards } from '../schema.js';

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
