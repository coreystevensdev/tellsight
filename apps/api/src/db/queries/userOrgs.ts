import { eq, and } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
import { userOrgs } from '../schema.js';

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

/** Cross-org lookup — auth flow runs outside RLS context, caller must pass dbAdmin */
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
