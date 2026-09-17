import { eq, and } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { userOrgs, users } from '../schema.js';

export async function addMember(
  orgId: number,
  userId: number,
  role: 'owner' | 'member' = 'member',
  client: typeof db | DbTransaction = db,
) {
  const [membership] = await client
    .insert(userOrgs)
    .values({ orgId, userId, role })
    .returning();
  if (!membership) throw new Error('Insert failed to return membership');
  return membership;
}

export async function findMembership(
  orgId: number,
  userId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.userOrgs.findFirst({
    where: and(eq(userOrgs.orgId, orgId), eq(userOrgs.userId, userId)),
  });
}

/** Cross-org lookup, auth flow runs outside RLS context, caller must pass dbAdmin */
export async function getUserOrgs(
  userId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.userOrgs.findMany({
    where: eq(userOrgs.userId, userId),
    with: { org: true },
  });
}

export async function getOrgOwnerId(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<number | null> {
  const result = await client.query.userOrgs.findFirst({
    where: and(eq(userOrgs.orgId, orgId), eq(userOrgs.role, 'owner')),
    columns: { userId: true },
  });
  return result?.userId ?? null;
}

export async function getOrgMembers(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.userOrgs.findMany({
    where: eq(userOrgs.orgId, orgId),
    with: { user: true },
  });
}

/** The caller's standing as the database has it right now, not as their token
 *  remembered it. Returns null once the membership is gone, which is what a
 *  deleted account and a removed member both look like from here.
 *  Runs before any RLS context exists, so the caller passes dbAdmin. */
export async function findCallerContext(
  userId: number,
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  const [row] = await client
    .select({ role: userOrgs.role, isPlatformAdmin: users.isPlatformAdmin })
    .from(userOrgs)
    .innerJoin(users, eq(users.id, userOrgs.userId))
    .where(and(eq(userOrgs.userId, userId), eq(userOrgs.orgId, orgId)));

  return row ?? null;
}

/** Returns the deleted membership, or undefined when the user was not in this org.
 *  Nothing else needs revoking: the removed member's access token fails
 *  currentMembership on its next request, and rotateRefreshToken already refuses
 *  to mint a new pair for an org the user no longer belongs to. */
export async function removeMember(
  orgId: number,
  userId: number,
  client: typeof db | DbTransaction = db,
) {
  const [removed] = await client
    .delete(userOrgs)
    .where(and(eq(userOrgs.orgId, orgId), eq(userOrgs.userId, userId)))
    .returning();

  return removed;
}
