import { and, eq, lt, sql } from 'drizzle-orm';
import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import { shares } from '../schema.js';

export async function createShare(
  orgId: number,
  datasetId: number,
  tokenHash: string,
  insightSnapshot: Record<string, unknown>,
  createdBy: number,
  expiresAt: Date,
  client: typeof db | DbTransaction = db,
) {
  const [share] = await client
    .insert(shares)
    .values({ orgId, datasetId, tokenHash, insightSnapshot, createdBy, expiresAt })
    .returning();
  if (!share) throw new Error('Insert failed to return share');
  return share;
}

export async function findByTokenHash(
  tokenHash: string,
  client: typeof db | DbTransaction = db,
) {
  return client.query.shares.findFirst({
    where: eq(shares.tokenHash, tokenHash),
    with: { org: true },
  });
}

export async function incrementViewCount(
  id: number,
  client: typeof db | DbTransaction = db,
) {
  const [share] = await client
    .update(shares)
    .set({ viewCount: sql`${shares.viewCount} + 1` })
    .where(eq(shares.id, id))
    .returning();
  if (!share) throw new Error(`Share ${id} not found during view count increment`);
  return share;
}

export async function deleteExpired(): Promise<number> {
  const deleted = await dbAdmin
    .delete(shares)
    .where(lt(shares.expiresAt, new Date()))
    .returning({ id: shares.id });
  return deleted.length;
}

export async function getSharesByOrg(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.shares.findMany({
    where: eq(shares.orgId, orgId),
  });
}

/** Scoped to the org, same as deleteInvite. Deleting matches how shares already
 *  end: deleteExpired removes the row rather than marking it. */
export async function deleteShare(
  orgId: number,
  shareId: number,
  client: typeof db | DbTransaction = db,
) {
  const [deleted] = await client
    .delete(shares)
    .where(and(eq(shares.id, shareId), eq(shares.orgId, orgId)))
    .returning();

  return deleted;
}
