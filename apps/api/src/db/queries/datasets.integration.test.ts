import { inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, datasets } from '../schema.js';
import { getDatasetListWithCounts } from './datasets.js';

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
