import { eq, and, isNull } from 'drizzle-orm';

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

export async function markStale(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(aiSummaries)
    .set({ staleAt: new Date() })
    .where(and(eq(aiSummaries.orgId, orgId), isNull(aiSummaries.staleAt)));
}
