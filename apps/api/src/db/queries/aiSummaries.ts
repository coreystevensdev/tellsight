import { eq, and, isNull, desc } from 'drizzle-orm';

import { db, type DbTransaction } from '../../lib/db.js';
import { aiSummaries } from '../schema.js';

export type SummaryAudience = 'dashboard' | 'digest-weekly' | 'share' | 'alert';

export async function getCachedSummary(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: and(
      eq(aiSummaries.orgId, orgId),
      eq(aiSummaries.datasetId, datasetId),
      eq(aiSummaries.audience, 'dashboard'),
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
      eq(aiSummaries.audience, 'dashboard'),
    ),
    orderBy: [desc(aiSummaries.createdAt)],
  });
}

/** Direct lookup by primary key. Used by the per-send digest worker which
 *  carries the summaryId in the job payload (not the dataset/week tuple). */
export async function getById(
  id: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: eq(aiSummaries.id, id),
  });
}

/** Digest-audience cache lookup. weekStart pins the row to a specific week so
 *  back-to-back Sunday cron ticks land on the same cached row. */
export async function getCachedDigest(
  orgId: number,
  datasetId: number,
  weekStart: Date,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: and(
      eq(aiSummaries.orgId, orgId),
      eq(aiSummaries.datasetId, datasetId),
      eq(aiSummaries.audience, 'digest-weekly'),
      eq(aiSummaries.weekStart, weekStart),
    ),
  });
}

/** Alert-audience cache lookup. Alerts are one-shot per fire event, not
 *  week-pinned like digest, so cache identity uses fireId instead of weekStart. */
export async function getCachedAlertSummary(
  orgId: number,
  datasetId: number,
  fireId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.aiSummaries.findFirst({
    where: and(
      eq(aiSummaries.orgId, orgId),
      eq(aiSummaries.datasetId, datasetId),
      eq(aiSummaries.audience, 'alert'),
      eq(aiSummaries.fireId, fireId),
    ),
  });
}

export interface StoreSummaryOpts {
  orgId: number;
  datasetId: number;
  content: string;
  metadata: Record<string, unknown>;
  promptVersion: string;
  isSeed?: boolean;
  audience?: SummaryAudience;
  weekStart?: Date | null;
  fireId?: number | null;
  client?: typeof db | DbTransaction;
}

export async function storeSummary(opts: StoreSummaryOpts) {
  const {
    orgId,
    datasetId,
    content,
    metadata,
    promptVersion,
    isSeed = false,
    audience = 'dashboard',
    weekStart = null,
    fireId = null,
    client = db,
  } = opts;

  const [row] = await client
    .insert(aiSummaries)
    .values({
      orgId,
      datasetId,
      content,
      transparencyMetadata: metadata,
      promptVersion,
      isSeed,
      audience,
      weekStart,
      fireId,
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
