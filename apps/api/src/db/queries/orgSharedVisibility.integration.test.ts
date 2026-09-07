import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { withRlsContext } from '../../lib/rls.js';
import { orgs, users, userOrgs, datasets } from '../schema.js';
import { getDatasetListWithCounts, getDatasetsByOrg, getDatasetById } from './datasets.js';
import { getRowsByDataset } from './dataRows.js';
import { insertBatch } from './dataRows.js';

// FR10 has two clauses. "Scoped to the org" is covered in several places. "Visible
// to all members of that organization" was covered nowhere, because every fixture
// in the suite seeds exactly one user per org, so a read scoped to the uploader
// rather than to the org would look identical in all of them.
//
// This seeds two members and asks the second one's session for the first one's
// data. Runs through withRlsContext rather than dbAdmin, because the claim is
// about what a member's own request can see, and RLS is what decides that.
//
// The mirror case matters as much: a member of a different org must still get
// nothing, or "visible to everyone" would pass by returning everything.

const suffix = `shared-vis-${process.pid}`;
const createdOrgs: number[] = [];
const createdUsers: number[] = [];

let orgId: number;
let otherOrgId: number;
let uploader: number;
let colleague: number;
let outsider: number;
let datasetId: number;

async function makeUser(label: string): Promise<number> {
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `${label}-${suffix}@example.com`, name: label })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  return user!.id;
}

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'shared visibility', slug: `shared-vis-${suffix}` })
    .returning({ id: orgs.id });
  orgId = org!.id;
  createdOrgs.push(orgId);

  const [other] = await dbAdmin
    .insert(orgs)
    .values({ name: 'other org', slug: `shared-vis-other-${suffix}` })
    .returning({ id: orgs.id });
  otherOrgId = other!.id;
  createdOrgs.push(otherOrgId);

  uploader = await makeUser('uploader');
  colleague = await makeUser('colleague');
  outsider = await makeUser('outsider');

  await dbAdmin.insert(userOrgs).values([
    { orgId, userId: uploader, role: 'owner' },
    { orgId, userId: colleague, role: 'member' },
    { orgId: otherOrgId, userId: outsider, role: 'owner' },
  ]);

  // Uploaded by one member, with that member recorded as the uploader, which is
  // the column a uploader-scoped read would filter on.
  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId, name: 'Q1 Financials', uploadedBy: uploader })
    .returning({ id: datasets.id });
  datasetId = dataset!.id;

  await insertBatch(
    orgId,
    datasetId,
    [{ category: 'Revenue', date: new Date('2026-01-15'), amount: '1200.00' }],
    dbAdmin,
  );
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('a dataset uploaded by one member, read by another', () => {
  it('appears in the colleague list view', async () => {
    const rows = await withRlsContext(orgId, false, (tx) =>
      getDatasetListWithCounts(orgId, null, tx),
    );

    expect(rows.map((r) => r.id)).toContain(datasetId);
  });

  it('still records who uploaded it, so shared does not mean anonymous', async () => {
    const rows = await withRlsContext(orgId, false, (tx) =>
      getDatasetListWithCounts(orgId, null, tx),
    );
    const mine = rows.find((r) => r.id === datasetId);

    expect(mine!.uploadedBy).toEqual({ id: uploader, name: 'uploader' });
  });

  it('is fetchable by id from the colleague session', async () => {
    const found = await withRlsContext(orgId, false, (tx) => getDatasetById(orgId, datasetId, tx));

    expect(found).toBeDefined();
  });

  it('lists for the org rather than for the uploader', async () => {
    const rows = await withRlsContext(orgId, false, (tx) => getDatasetsByOrg(orgId, tx));

    expect(rows.map((r) => r.id)).toContain(datasetId);
  });

  it('carries its rows through to the colleague as well', async () => {
    const rows = await withRlsContext(orgId, false, (tx) => getRowsByDataset(orgId, datasetId, tx));

    expect(rows).toHaveLength(1);
  });

  // The mirror. Without it, a read that returned everything would satisfy every
  // case above.
  it('is invisible to a member of a different org', async () => {
    const rows = await withRlsContext(otherOrgId, false, (tx) =>
      getDatasetListWithCounts(otherOrgId, null, tx),
    );

    expect(rows.map((r) => r.id)).not.toContain(datasetId);
  });

  it('is not fetchable by id from the other org session either', async () => {
    const found = await withRlsContext(otherOrgId, false, (tx) =>
      getDatasetById(otherOrgId, datasetId, tx),
    );

    expect(found).toBeUndefined();
  });

  // Both members resolve to the same org, which is what makes the reads above
  // the same reads. A membership row per user is the whole mechanism.
  it('has both members on the org, with different roles', async () => {
    const rows = await dbAdmin.select().from(userOrgs).where(eq(userOrgs.orgId, orgId));

    expect(rows.map((r) => r.userId).sort()).toEqual([uploader, colleague].sort());
    expect(rows.find((r) => r.userId === colleague)!.role).toBe('member');
  });
});
