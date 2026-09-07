import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions } from '../schema.js';
import { updateSubscriptionStatus, getActiveTier } from './subscriptions.js';

// Stripe redelivers webhooks. updateSubscriptionStatus is what makes a replay a
// no-op: it returns the number of rows it changed, and the webhook handler reads
// that to decide whether the transition is new work or something it has already
// done. The unit tests hand that number back directly -- mockResolvedValueOnce(1)
// then (0) -- so the predicate producing it was never run. Removing
// ne(subscriptions.status, status) left 882 unit and 102 integration tests green,
// with every replay reporting as new work and firing its side effects again.

const createdOrgs: number[] = [];

afterAll(async () => {
  if (createdOrgs.length) {
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
});

async function seedSubscription(label: string, status: string): Promise<string> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `sub-idem-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);

  const stripeSubscriptionId = `sub_${label}_${Date.now()}`;
  await dbAdmin.insert(subscriptions).values({
    orgId: org!.id,
    status,
    plan: 'pro',
    stripeSubscriptionId,
    stripeCustomerId: `cus_${label}`,
  });

  return stripeSubscriptionId;
}

describe('updateSubscriptionStatus against real Postgres', () => {
  it('reports one row changed, then zero when the same event is redelivered', async () => {
    const subId = await seedSubscription('replay', 'active');

    expect(await updateSubscriptionStatus(subId, 'past_due', undefined, dbAdmin)).toBe(1);
    expect(await updateSubscriptionStatus(subId, 'past_due', undefined, dbAdmin)).toBe(0);
  });

  it('still reports a change when the status actually moves on', async () => {
    const subId = await seedSubscription('progress', 'active');

    await updateSubscriptionStatus(subId, 'past_due', undefined, dbAdmin);

    expect(await updateSubscriptionStatus(subId, 'canceled', undefined, dbAdmin)).toBe(1);
  });

  it('touches nothing when the subscription id is unknown', async () => {
    expect(await updateSubscriptionStatus('sub_does_not_exist', 'canceled', undefined, dbAdmin)).toBe(0);
  });

  // The other half of the same row: a status the entitlement query does not
  // count as paid has to actually read back as free from a live database, not
  // just from a where clause that was built correctly.
  it('drops the org to free once the subscription goes past_due', async () => {
    const subId = await seedSubscription('revoke', 'active');
    const orgId = createdOrgs[createdOrgs.length - 1]!;

    expect(await getActiveTier(orgId, dbAdmin)).toBe('pro');

    await updateSubscriptionStatus(subId, 'past_due', undefined, dbAdmin);

    expect(await getActiveTier(orgId, dbAdmin)).toBe('free');
  });

  it('writes the status the caller asked for', async () => {
    const subId = await seedSubscription('written', 'active');

    await updateSubscriptionStatus(subId, 'unpaid', undefined, dbAdmin);

    const [row] = await dbAdmin
      .select({ status: subscriptions.status })
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subId));

    expect(row!.status).toBe('unpaid');
  });
});
