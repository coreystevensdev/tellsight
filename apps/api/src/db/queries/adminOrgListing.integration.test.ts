import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, userOrgs, datasets, subscriptions } from '../schema.js';
import { getAllOrgs } from './admin.js';

// getAllOrgs is the platform admin's whole view of the system. Its three joins
// are left joins on purpose: an org with no members, no datasets, or no
// subscription row still has to appear. Swapping all three for inner joins left
// 2,483 unit and 107 integration tests green, and admin.test.ts cannot see it at
// all because it mocks drizzle-orm itself.
//
// The org that disappears under that mutation is the one an admin most needs:
// brand new, nothing attached to it yet.

const createdOrgs: number[] = [];
const createdUsers: number[] = [];
let bare: number;
let populated: number;

async function makeOrg(label: string): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `admin-list-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  return org!.id;
}

beforeAll(async () => {
  // Nothing attached: no member, no dataset, no subscription.
  bare = await makeOrg('bare');

  populated = await makeOrg('populated');
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `admin-list-${Date.now()}@test.local`, name: 'Member' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await dbAdmin.insert(userOrgs).values({ orgId: populated, userId: user!.id, role: 'owner' });
  await dbAdmin.insert(datasets).values({ orgId: populated, name: 'Q1' });
  await dbAdmin.insert(subscriptions).values({
    orgId: populated,
    status: 'active',
    plan: 'pro',
    stripeCustomerId: `cus_admin_list_${Date.now()}`,
  });
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('getAllOrgs against real Postgres', () => {
  it('lists an org with no members, no datasets and no subscription', async () => {
    const ids = (await getAllOrgs()).map((r) => r.id);

    expect(ids).toContain(bare);
  });

  it('reports zero counts and a null tier for that org rather than omitting it', async () => {
    const row = (await getAllOrgs()).find((r) => r.id === bare);

    expect(row).toBeDefined();
    expect(row!.memberCount).toBe(0);
    expect(row!.datasetCount).toBe(0);
    expect(row!.subscriptionTier).toBeNull();
  });

  it('counts members and datasets for an org that has them', async () => {
    const row = (await getAllOrgs()).find((r) => r.id === populated);

    expect(row).toBeDefined();
    expect(row!.memberCount).toBe(1);
    expect(row!.datasetCount).toBe(1);
    expect(row!.subscriptionTier).toBe('pro');
  });

  // count(distinct) rather than count(*): the three joins multiply rows against
  // each other, so a second dataset would otherwise inflate memberCount too.
  it('does not let a second dataset inflate the member count', async () => {
    await dbAdmin.insert(datasets).values({ orgId: populated, name: 'Q2' });

    const row = (await getAllOrgs()).find((r) => r.id === populated);

    expect(row!.datasetCount).toBe(2);
    expect(row!.memberCount).toBe(1);

    await dbAdmin.delete(datasets).where(eq(datasets.name, 'Q2'));
  });
});
