import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, datasets, statCorrections } from '../schema.js';
import { getActiveCorrectionStatIds } from './statCorrections.js';

// The comment above this query states an invariant: "The only allowed effect of
// an approved Tier 2 correction". Both halves of the predicate that enforces it
// could be deleted with 2,509 unit and 124 integration tests green.
//
// Dropping the status check applies a correction nobody has approved yet, so a
// Tier 2 request suppresses the stat the moment it is filed rather than when it
// is reviewed. Dropping the org check applies one tenant's corrections to
// another's dashboard. A comment asserting an invariant is the strongest signal
// that the invariant needs a test.

const suffix = `sc-scope-${process.pid}`;
const createdOrgs: number[] = [];
let orgId: number;
let otherOrgId: number;

async function correction(
  org: number,
  datasetId: number,
  statInstanceId: string,
  status: 'pending' | 'approved' | 'rejected' | 'expired',
): Promise<void> {
  await dbAdmin.insert(statCorrections).values({
    orgId: org,
    datasetId,
    statInstanceId,
    note: `note for ${statInstanceId}`,
    status,
  });
}

async function seedOrg(label: string): Promise<{ orgId: number; datasetId: number }> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `${suffix}-${label}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId: org!.id, name: `${label} data` })
    .returning({ id: datasets.id });
  return { orgId: org!.id, datasetId: dataset!.id };
}

beforeAll(async () => {
  const mine = await seedOrg('mine');
  orgId = mine.orgId;
  const theirs = await seedOrg('theirs');
  otherOrgId = theirs.orgId;

  await correction(orgId, mine.datasetId, 'stat:approved', 'approved');
  await correction(orgId, mine.datasetId, 'stat:pending', 'pending');
  await correction(orgId, mine.datasetId, 'stat:rejected', 'rejected');
  await correction(orgId, mine.datasetId, 'stat:expired', 'expired');
  await correction(otherOrgId, theirs.datasetId, 'stat:other-org-approved', 'approved');
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

describe('getActiveCorrectionStatIds against real Postgres', () => {
  it('returns an approved correction', async () => {
    expect(await getActiveCorrectionStatIds(orgId, dbAdmin)).toContain('stat:approved');
  });

  // Filed but not reviewed. Suppressing on this would let anyone silence a stat
  // by asking, which is the thing the approval step exists to prevent.
  it('ignores a correction that is still pending review', async () => {
    expect(await getActiveCorrectionStatIds(orgId, dbAdmin)).not.toContain('stat:pending');
  });

  it('ignores a rejected correction', async () => {
    expect(await getActiveCorrectionStatIds(orgId, dbAdmin)).not.toContain('stat:rejected');
  });

  // The expiry sweep flips rows to 'expired' rather than deleting them, and the
  // status filter is what makes them stop applying.
  it('ignores an expired correction', async () => {
    expect(await getActiveCorrectionStatIds(orgId, dbAdmin)).not.toContain('stat:expired');
  });

  it('never returns another org approved correction', async () => {
    expect(await getActiveCorrectionStatIds(orgId, dbAdmin)).not.toContain('stat:other-org-approved');
  });

  // The mirror, so a query that returned nothing at all could not satisfy the
  // four negatives above.
  it('returns that correction to the org that owns it', async () => {
    expect(await getActiveCorrectionStatIds(otherOrgId, dbAdmin)).toEqual(['stat:other-org-approved']);
  });
});
