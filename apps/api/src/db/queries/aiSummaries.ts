import { eq, and, isNull, desc } from 'drizzle-orm';

import { db, type DbTransaction } from '../../lib/db.js';
import { aiSummaries } from '../schema.js';

export async function getCachedSummary(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: and(
      eq(aiSummaries.orgId, orgId),
      eq(aiSummaries.datasetId, datasetId),
      isNull(aiSummaries.staleAt),
    ),
  });
}

/** Returns the most recent summary regardless of staleness.
 *  Callers that need the staleness signal (e.g., the "data updated, refresh?"
 *  banner) use this; the streaming cache-hit path keeps using getCachedSummary. */
export async function getLatestSummary(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: and(
      eq(aiSummaries.orgId, orgId),
      eq(aiSummaries.datasetId, datasetId),
    ),
    orderBy: [desc(aiSummaries.createdAt)],
  });
}

export async function storeSummary(
  orgId: number,
  datasetId: number,
  content: string,
  metadata: Record<string, unknown>,
  promptVersion: string,
  isSeed = false,
  client: typeof db | DbTransaction = db,
) {
  const [row] = await client
    .insert(aiSummaries)
    .values({
      orgId,
      datasetId,
      content,
      transparencyMetadata: metadata,
      promptVersion,
      isSeed,
    })
    .returning();
  return row!;
}

/** Invalidates cached summaries. Pass datasetId to scope invalidation
 *  to the affected dataset only, avoids unnecessary Claude API calls. */
export async function markStale(
  orgId: number,
  client: typeof db | DbTransaction = db,
  datasetId?: number,
) {
  const conditions = [eq(aiSummaries.orgId, orgId), isNull(aiSummaries.staleAt)];
  if (datasetId !== undefined) {
    conditions.push(eq(aiSummaries.datasetId, datasetId));
  }

  await client
    .update(aiSummaries)
    .set({ staleAt: new Date() })
    .where(and(...conditions));
}
