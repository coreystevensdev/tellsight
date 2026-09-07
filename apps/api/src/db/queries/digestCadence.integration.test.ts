import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, userOrgs, digestPreferences } from '../schema.js';
import { findOrgRecipients } from './digestEligibility.js';

// The cadence enum has offered weekly, monthly and off since it shipped, and the
// settings UI offers all three. findOrgRecipients only ever matched weekly and
// null, so picking monthly produced byte-identical behaviour to off: no digest,
// ever, with nothing to indicate it. The unit tests here assert the emitted SQL
// shape, which cannot tell whether a monthly row comes back.
//
// Windows are asserted from both sides, because a predicate that matches
// everything and one that matches nothing both look like "monthly works" from a
// single row.

const createdOrgs: number[] = [];
const createdUsers: number[] = [];
let orgId: number;

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

async function member(label: string, cadence: string, lastSentAt: Date | null): Promise<number> {
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `cadence-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`, name: label })
    .returning({ id: users.id });
  createdUsers.push(user!.id);

  await dbAdmin.insert(userOrgs).values({ orgId, userId: user!.id, role: 'member' });
  await dbAdmin.insert(digestPreferences).values({ userId: user!.id, cadence, lastSentAt });

  return user!.id;
}

let weeklyDue: number;
let weeklyRecent: number;
let monthlyDue: number;
let monthlyRecent: number;
let monthlyNeverSent: number;
let offUser: number;

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'cadence org', slug: `cadence-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  orgId = org!.id;

  weeklyDue = await member('weekly-due', 'weekly', daysAgo(8));
  weeklyRecent = await member('weekly-recent', 'weekly', daysAgo(2));
  monthlyDue = await member('monthly-due', 'monthly', daysAgo(40));
  monthlyRecent = await member('monthly-recent', 'monthly', daysAgo(10));
  monthlyNeverSent = await member('monthly-new', 'monthly', null);
  offUser = await member('off', 'off', daysAgo(90));
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('findOrgRecipients cadence windows against real Postgres', () => {
  it('includes a monthly member whose last send is past the window', async () => {
    const ids = (await findOrgRecipients(orgId)).map((r) => r.userId);

    expect(ids).toContain(monthlyDue);
  });

  it('includes a monthly member who has never been sent one', async () => {
    const ids = (await findOrgRecipients(orgId)).map((r) => r.userId);

    expect(ids).toContain(monthlyNeverSent);
  });

  // The half that a predicate matching everything would fail: ten days is past
  // the weekly window and well inside the monthly one.
  it('holds back a monthly member sent ten days ago, which weekly would have released', async () => {
    const ids = (await findOrgRecipients(orgId)).map((r) => r.userId);

    expect(ids).not.toContain(monthlyRecent);
    expect(ids).toContain(weeklyDue);
  });

  it('still applies the weekly window to weekly members', async () => {
    const ids = (await findOrgRecipients(orgId)).map((r) => r.userId);

    expect(ids).toContain(weeklyDue);
    expect(ids).not.toContain(weeklyRecent);
  });

  it('never includes an off-cadence member, however long since their last send', async () => {
    const ids = (await findOrgRecipients(orgId)).map((r) => r.userId);

    expect(ids).not.toContain(offUser);
  });
});
