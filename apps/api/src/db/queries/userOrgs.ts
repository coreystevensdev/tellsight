import { eq, and } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { userOrgs } from '../schema.js';

export async function addMember(
  orgId: number,
  userId: number,
  role: 'owner' | 'member' = 'member',
) {
  const [membership] = await db
    .insert(userOrgs)
    .values({ orgId, userId, role })
    .returning();
  if (!membership) throw new Error('Insert failed to return membership');
  return membership;
}

export async function findMembership(orgId: number, userId: number) {
  return db.query.userOrgs.findFirst({
    where: and(eq(userOrgs.orgId, orgId), eq(userOrgs.userId, userId)),
  });
}

/** Cross-org lookup — returns all org memberships for a user (auth-flow only, intentional exception) */
export async function getUserOrgs(userId: number) {
  return db.query.userOrgs.findMany({
    where: eq(userOrgs.userId, userId),
    with: { org: true },
  });
}

export async function getOrgOwnerId(orgId: number): Promise<number | null> {
  const result = await db.query.userOrgs.findFirst({
    where: and(eq(userOrgs.orgId, orgId), eq(userOrgs.role, 'owner')),
    columns: { userId: true },
  });
  return result?.userId ?? null;
}

export async function getOrgMembers(orgId: number) {
  return db.query.userOrgs.findMany({
    where: eq(userOrgs.orgId, orgId),
    with: { user: true },
  });
}
