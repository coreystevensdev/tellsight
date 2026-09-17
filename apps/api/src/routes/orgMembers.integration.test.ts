import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { findCallerContext, removeMember } from '../db/queries/userOrgs.js';
import { orgs, userOrgs, users } from '../db/schema.js';
import { dbAdmin } from '../lib/db.js';
import { createOwnerOrgForUser, resolvePrimaryMembership } from '../services/auth/orgOnboarding.js';

// Removal is only worth anything if it actually ends the session, and what ends
// it is currentMembership finding nothing. That is a fact about a delete and a
// select agreeing, which a mocked client cannot check.

const created: number[] = [];

async function makeUser(label: string) {
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `${label}-${Date.now()}-${Math.random()}@example.invalid`, name: label })
    .returning({ id: users.id });
  if (!user) throw new Error('user insert returned no rows');
  created.push(user.id);
  return user.id;
}

beforeEach(() => { created.length = 0; });

afterAll(async () => {
  if (created.length) await dbAdmin.delete(users).where(inArray(users.id, created));
});

describe('removeMember against real Postgres', () => {
  it('leaves nothing for authMiddleware to find, for that org only', async () => {
    const owner = await makeUser('keeps-org');
    const member = await makeUser('gets-removed');
    const { org } = await createOwnerOrgForUser(owner, `Team ${Date.now()}`);
    const { org: otherOrg } = await createOwnerOrgForUser(member, `Their own ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: member, role: 'member' });

    expect(await findCallerContext(member, org.id, dbAdmin)).toMatchObject({ role: 'member' });

    const removed = await removeMember(org.id, member, dbAdmin);

    expect(removed?.userId).toBe(member);
    expect(await findCallerContext(member, org.id, dbAdmin)).toBeNull();
    // their own org is untouched, so the removal is not a de facto account ban
    expect(await findCallerContext(member, otherOrg.id, dbAdmin)).toMatchObject({ role: 'owner' });
    expect(await findCallerContext(owner, org.id, dbAdmin)).toMatchObject({ role: 'owner' });

    await dbAdmin.delete(orgs).where(inArray(orgs.id, [org.id, otherOrg.id]));
  });

  it('removes the person without removing the person', async () => {
    const owner = await makeUser('owner-keeps');
    const member = await makeUser('member-survives');
    const { org } = await createOwnerOrgForUser(owner, `Survives ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: member, role: 'member' });

    await removeMember(org.id, member, dbAdmin);

    expect(await dbAdmin.select().from(users).where(eq(users.id, member))).toHaveLength(1);

    await dbAdmin.delete(orgs).where(eq(orgs.id, org.id));
  });

  it('returns nothing when the person was never in the org', async () => {
    const owner = await makeUser('lonely-owner');
    const stranger = await makeUser('stranger');
    const { org } = await createOwnerOrgForUser(owner, `Lonely ${Date.now()}`);

    expect(await removeMember(org.id, stranger, dbAdmin)).toBeUndefined();

    await dbAdmin.delete(orgs).where(eq(orgs.id, org.id));
  });

  // The whole loop: someone who joined by invite has no org of their own, so
  // removing them used to leave an account that could not sign in and, because
  // account deletion is behind auth, could not be closed either.
  it('leaves a removed invitee able to sign in again, with an org of their own', async () => {
    const owner = await makeUser('inviting-owner');
    const invitee = await makeUser('invitee');
    const { org } = await createOwnerOrgForUser(owner, `Invited ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: invitee, role: 'member' });

    await removeMember(org.id, invitee, dbAdmin);
    expect(await findCallerContext(invitee, org.id, dbAdmin)).toBeNull();

    const repaired = await resolvePrimaryMembership(invitee, 'Invitee');

    expect(repaired.org.id).not.toBe(org.id);
    expect(repaired.role).toBe('owner');
    expect(await findCallerContext(invitee, repaired.org.id, dbAdmin)).toMatchObject({ role: 'owner' });

    await dbAdmin.delete(orgs).where(inArray(orgs.id, [org.id, repaired.org.id]));
  });
});
