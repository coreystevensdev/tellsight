import { eq, and, desc, ne, sql, count } from 'drizzle-orm';
import type { DemoModeState } from 'shared/types';
import { db, type DbTransaction } from '../../lib/db.js';
import { datasets, dataRows, aiSummaries, shares, users } from '../schema.js';
import type { NormalizedRow } from '../../services/dataIngestion/normalizer.js';
// Deliberate cross-query imports, persistUpload orchestrates both query modules.
// Do NOT add imports from datasets.ts into dataRows.ts (circular dependency risk).
import { insertBatch } from './dataRows.js';
import { markStale } from './aiSummaries.js';

/** Atomic upload: delete seed data, insert dataset + rows, compute demo state.
 *  When called within withRlsContext, pass the outer tx to reuse its RLS session. */
export async function persistUpload(
  orgId: number,
  userId: number,
  fileName: string,
  normalizedRows: NormalizedRow[],
  outerTx?: DbTransaction,
) {
  const run = async (tx: DbTransaction) => {
    await deleteSeedDatasets(orgId, tx);

    const dataset = await createDataset(orgId, {
      name: fileName,
      sourceType: 'csv',
      uploadedBy: userId,
    }, tx);
    await insertBatch(orgId, dataset.id, normalizedRows, tx);

    await markStale(orgId, tx);

    const demoState = await getUserOrgDemoState(orgId, tx);
    return { datasetId: dataset.id, rowCount: normalizedRows.length, demoState };
  };

  return outerTx ? run(outerTx) : db.transaction(run);
}

export async function createDataset(
  orgId: number,
  data: {
    name: string;
    sourceType?: 'csv' | 'quickbooks' | 'xero' | 'stripe' | 'plaid' | 'shopify' | 'square';
    isSeedData?: boolean;
    uploadedBy?: number | null;
  },
  client: typeof db | DbTransaction = db,
) {
  const [dataset] = await client
    .insert(datasets)
    .values({ orgId, ...data })
    .returning();
  if (!dataset) throw new Error('Insert failed to return dataset');
  return dataset;
}

export async function getDatasetsByOrg(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.datasets.findMany({
    where: eq(datasets.orgId, orgId),
    orderBy: desc(datasets.createdAt),
  });
}

/** A new org is seeded with demo data at sign-up, so 'seed_only' is reachable here
 *  and not just at the view layer for signed-out visitors. 'seed_plus_user' stays
 *  unreachable: persistUpload deletes the seed datasets before inserting the user's,
 *  so the two never coexist. 'empty' now means the sign-up seed failed or the user
 *  deleted their only upload. */
export async function getUserOrgDemoState(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<DemoModeState> {
  const found = await client
    .select({ isSeedData: datasets.isSeedData })
    .from(datasets)
    .where(eq(datasets.orgId, orgId));

  if (found.some((d) => !d.isSeedData)) return 'user_only';
  return found.length > 0 ? 'seed_only' : 'empty';
}

export async function getSeedDataset(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.datasets.findFirst({
    where: and(eq(datasets.orgId, orgId), eq(datasets.isSeedData, true)),
  });
}

/** Removes all seed datasets (and their data rows via cascade) for an org. */
export async function deleteSeedDatasets(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  return client
    .delete(datasets)
    .where(and(eq(datasets.orgId, orgId), eq(datasets.isSeedData, true)));
}

// Distinct from alertRuleFires' 771. Sharing a namespace would make an alert
// fire and a dataset upload for the same org block each other for no reason,
// since advisory locks only collide within a namespace.
const DATASET_QUOTA_LOCK_NAMESPACE = 772;

/**
 * Serializes same-org callers across the count-then-insert in the upload path.
 *
 * Without it the check is a race: two uploads read the same count under the
 * limit before either commits, and both insert. READ COMMITTED is the default
 * here, so neither transaction sees the other's uncommitted row. Demonstrated
 * against a real database at 21 rows for a limit of 20.
 *
 * The lock is transaction-scoped, so it releases on commit or rollback with no
 * unlock call to forget. Same shape as alertRuleFires.createIfUnderQuota, which
 * solves the identical problem for alert quotas.
 */
export async function lockOrgForDatasetQuota(
  orgId: number,
  client: typeof db | DbTransaction,
): Promise<void> {
  // Bounds how long a stuck holder can block another upload. Failing fast with
  // a 500 beats holding an HTTP connection open indefinitely.
  await client.execute(sql`set local lock_timeout = '5s'`);
  await client.execute(sql`select pg_advisory_xact_lock(${DATASET_QUOTA_LOCK_NAMESPACE}, ${orgId})`);
}

export async function getNonSeedDatasetCount(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<number> {
  const [row] = await client
    .select({ value: count() })
    .from(datasets)
    .where(and(eq(datasets.orgId, orgId), eq(datasets.isSeedData, false)));
  return row?.value ?? 0;
}

export async function getDatasetById(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  return client.query.datasets.findFirst({
    where: and(eq(datasets.orgId, orgId), eq(datasets.id, datasetId)),
  });
}

export async function getDatasetWithCounts(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  const dataset = await client.query.datasets.findFirst({
    where: and(eq(datasets.orgId, orgId), eq(datasets.id, datasetId)),
  });
  if (!dataset) return null;

  const [[rowCount], [summaryCount], [shareCount]] = await Promise.all([
    client
      .select({ count: sql<number>`count(*)::int` })
      .from(dataRows)
      .where(and(eq(dataRows.orgId, orgId), eq(dataRows.datasetId, datasetId))),
    client
      .select({ count: sql<number>`count(*)::int` })
      .from(aiSummaries)
      .where(and(eq(aiSummaries.orgId, orgId), eq(aiSummaries.datasetId, datasetId))),
    client
      .select({ count: sql<number>`count(*)::int` })
      .from(shares)
      .where(and(eq(shares.orgId, orgId), eq(shares.datasetId, datasetId))),
  ]);

  return {
    ...dataset,
    rowCount: rowCount?.count ?? 0,
    summaryCount: summaryCount?.count ?? 0,
    shareCount: shareCount?.count ?? 0,
  };
}

export async function getDatasetListWithCounts(
  orgId: number,
  activeDatasetId: number | null,
  client: typeof db | DbTransaction = db,
) {
  const rows = await client
    .select({
      id: datasets.id,
      orgId: datasets.orgId,
      name: datasets.name,
      sourceType: datasets.sourceType,
      isSeedData: datasets.isSeedData,
      uploadedById: users.id,
      uploadedByName: users.name,
      createdAt: datasets.createdAt,
      rowCount: sql<number>`coalesce(count(${dataRows.id}), 0)::int`,
    })
    .from(datasets)
    .leftJoin(dataRows, eq(dataRows.datasetId, datasets.id))
    .leftJoin(users, eq(users.id, datasets.uploadedBy))
    .where(and(eq(datasets.orgId, orgId), eq(datasets.isSeedData, false)))
    .groupBy(datasets.id, users.id, users.name)
    .orderBy(desc(datasets.createdAt));

  return rows.map(({ uploadedById, uploadedByName, ...ds }) => ({
    ...ds,
    uploadedBy: uploadedById != null && uploadedByName != null
      ? { id: uploadedById, name: uploadedByName }
      : null,
    isActive: ds.id === activeDatasetId,
  }));
}

export async function updateDatasetName(
  orgId: number,
  datasetId: number,
  name: string,
  client: typeof db | DbTransaction = db,
) {
  const [updated] = await client
    .update(datasets)
    .set({ name })
    .where(and(eq(datasets.id, datasetId), eq(datasets.orgId, orgId)))
    .returning();
  return updated ?? null;
}

export async function deleteDataset(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
) {
  const [deleted] = await client
    .delete(datasets)
    .where(
      and(
        eq(datasets.id, datasetId),
        eq(datasets.orgId, orgId),
        ne(datasets.isSeedData, true),
      ),
    )
    .returning();
  return deleted ?? null;
}
