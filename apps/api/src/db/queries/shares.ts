import { eq, sql } from 'drizzle-orm';
import { db, type DbTransaction } from '../../lib/db.js';
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

export async function getSharesByOrg(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.shares.findMany({
    where: eq(shares.orgId, orgId),
  });
}
