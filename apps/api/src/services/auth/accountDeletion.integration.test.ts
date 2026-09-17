import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { auditLogs, dataRows, datasets, orgs, refreshTokens, userOrgs, users } from '../../db/schema.js';
import { dbAdmin } from '../../lib/db.js';
import { createOwnerOrgForUser } from './orgOnboarding.js';
import { findCallerContext } from '../../db/queries/userOrgs.js';
import { deleteAccount } from './accountDeletion.js';

// The unit tests mock the db client, so they prove deleteAccount issues the right
// deletes and nothing about what those deletes take with them. Every claim about
// what survives a deletion is a claim about foreign keys, which only Postgres can
// settle.

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

describe('deleteAccount against real Postgres', () => {
  it('takes the org, its datasets and its rows when nobody else is in it', async () => {
    const userId = await makeUser('sole-owner');
    const { org } = await createOwnerOrgForUser(userId, `Sole ${Date.now()}`);

    const result = await deleteAccount(userId);

    expect(result.deletedOrgIds).toEqual([org.id]);
    expect(await dbAdmin.select().from(users).where(eq(users.id, userId))).toHaveLength(0);
    expect(await dbAdmin.select().from(orgs).where(eq(orgs.id, org.id))).toHaveLength(0);
    // the sign-up seed, gone with its org
    expect(await dbAdmin.select().from(datasets).where(eq(datasets.orgId, org.id))).toHaveLength(0);
    expect(await dbAdmin.select().from(dataRows).where(eq(dataRows.orgId, org.id))).toHaveLength(0);
  });

  it('takes the credentials that belong to the person', async () => {
    const userId = await makeUser('token-holder');
    const { org } = await createOwnerOrgForUser(userId, `Tokens ${Date.now()}`);
    await dbAdmin.insert(refreshTokens).values({
      tokenHash: `hash-${Date.now()}-${Math.random()}`, userId, orgId: org.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await deleteAccount(userId);

    expect(await dbAdmin.select().from(refreshTokens).where(eq(refreshTokens.userId, userId)))
      .toHaveLength(0);
  });

  // The de-attribution half: an org that outlives the user keeps its trail, and
  // the trail keeps everything except who did it.
  it('keeps the audit trail of a surviving org, without the name', async () => {
    const leaver = await makeUser('leaver');
    const stayer = await makeUser('stayer');
    const { org } = await createOwnerOrgForUser(stayer, `Shared ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: leaver, role: 'member' });
    const [entry] = await dbAdmin
      .insert(auditLogs)
      .values({ orgId: org.id, userId: leaver, action: 'dataset.uploaded' })
      .returning({ id: auditLogs.id });

    const result = await deleteAccount(leaver);

    expect(result).toEqual({ deletedOrgIds: [], leftOrgIds: [org.id] });
    expect(await dbAdmin.select().from(orgs).where(eq(orgs.id, org.id))).toHaveLength(1);

    const [survivor] = await dbAdmin.select().from(auditLogs).where(eq(auditLogs.id, entry!.id));
    expect(survivor?.action).toBe('dataset.uploaded');
    expect(survivor?.userId).toBeNull();

    expect(await dbAdmin.select().from(userOrgs).where(eq(userOrgs.userId, leaver))).toHaveLength(0);
  });

  // authMiddleware asks findCallerContext on every request, so this returning
  // null is what actually shuts a deleted account's still-valid access token out.
  // Without it the token keeps working for the rest of its 15 minutes.
  it('leaves nothing for authMiddleware to find afterwards', async () => {
    const userId = await makeUser('token-outlives');
    const { org } = await createOwnerOrgForUser(userId, `Outlives ${Date.now()}`);

    expect(await findCallerContext(userId, org.id, dbAdmin)).not.toBeNull();

    await deleteAccount(userId);

    expect(await findCallerContext(userId, org.id, dbAdmin)).toBeNull();
  });

  it('leaves nothing to find for an org the user was only removed from', async () => {
    const leaver = await makeUser('leaver2');
    const stayer = await makeUser('stayer2');
    const { org } = await createOwnerOrgForUser(stayer, `Shared2 ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: leaver, role: 'member' });

    await deleteAccount(leaver);

    expect(await findCallerContext(leaver, org.id, dbAdmin)).toBeNull();
    expect(await findCallerContext(stayer, org.id, dbAdmin)).toMatchObject({ role: 'owner' });
  });

  it('refuses to strand members with no owner, and changes nothing when it does', async () => {
    const owner = await makeUser('only-owner');
    const member = await makeUser('stranded');
    const { org } = await createOwnerOrgForUser(owner, `Stranding ${Date.now()}`);
    await dbAdmin.insert(userOrgs).values({ orgId: org.id, userId: member, role: 'member' });

    await expect(deleteAccount(owner)).rejects.toThrow(/transfer ownership/i);

    expect(await dbAdmin.select().from(users).where(eq(users.id, owner))).toHaveLength(1);
    expect(await dbAdmin.select().from(orgs).where(eq(orgs.id, org.id))).toHaveLength(1);
  });
});
