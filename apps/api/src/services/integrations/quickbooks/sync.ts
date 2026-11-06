import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { dbAdmin } from '../../../lib/db.js';
import { logger } from '../../../lib/logger.js';
import { dataRows } from '../../../db/schema.js';
import {
  integrationConnectionsQueries,
  syncJobsQueries,
  datasetsQueries,
  orgsQueries,
  aiSummariesQueries,
  userOrgsQueries,
} from '../../../db/queries/index.js';
import { trackEvent } from '../../analytics/trackEvent.js';
import { createQbClient } from './api.js';
import { ConnectionNotFoundError } from './errors.js';
import { normalizeTransactions } from './normalize.js';
import type { NormalizedQbRow, QbTransaction, QbTransactionType } from './types.js';

// Estimate is deliberately absent: it is a quote, not a transaction, and
// groupByCategory has no parentCategory filter, so its amount would land in
// the same category bucket (and the overall total) as real sales under the
// same item name.
const ENTITY_TYPES: QbTransactionType[] = [
  'Purchase',
  'Bill',
  'BillPayment',
  'VendorCredit',
  'Invoice',
  'Payment',
  'SalesReceipt',
  'Deposit',
  'CreditMemo',
  'RefundReceipt',
  'JournalEntry',
  'Transfer',
];

// postgres.js enforces a 65,533 total bind-parameter ceiling before a
// query reaches the wire (build.js:45). The insert chunks rows, so this
// alone bounds it (500 rows times ten columns is nowhere close). The
// delete is two-dimensional: an id list and the produced-row list for
// those same ids, and QuickBooks documents up to 750 line items on a
// taxable invoice with no cap stated for non-taxable ones, so bounding
// id count alone does not bound the produced-row side. Measured against
// the real client: 500 ids averaging 130 produced rows each is 65,504
// parameters and succeeds; at 131 it is 66,004 and throws
// MAX_PARAMETERS_EXCEEDED. The delete chunks by both dimensions instead,
// see chunkFetchedIds below.
const INSERT_BATCH_SIZE = 500;
const DELETE_ID_BATCH_SIZE = 500;
const DELETE_ROW_BUDGET = 500;

export type SyncTrigger = 'initial' | 'scheduled' | 'manual';

export interface SyncResult {
  rowsSynced: number;
  datasetId: number;
}

/**
 * Orchestrates a full QuickBooks sync:
 * fetch → normalize → upsert → mark-stale. Writes to sync_jobs
 * throughout so the UI can show progress. Errors update the job
 * and connection status and re-throw for BullMQ retry handling.
 */
export async function runSync(connectionId: number, trigger: SyncTrigger): Promise<SyncResult> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'quickbooks',
    dbAdmin,
  );
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const orgId = connection.orgId;
  const isInitial = trigger === 'initial';
  const since = isInitial ? undefined : (connection.lastSyncedAt ?? undefined);

  const job = await syncJobsQueries.create(
    {
      orgId,
      connectionId: connection.id,
      trigger,
      status: 'running',
      startedAt: new Date(),
    },
    dbAdmin,
  );

  await integrationConnectionsQueries.updateSyncStatus(connection.id, 'syncing', null, dbAdmin);

  try {
    const client = await createQbClient(connectionId);

    const { companyName } = await client.getCompanyInfo();

    const dataset = await findOrCreateQbDataset(orgId, companyName);

    let totalRows = 0;

    for (const entityType of ENTITY_TYPES) {
      const fetched = (await client.query(entityType, since)) as QbTransaction[];
      if (fetched.length === 0) continue;

      // A transaction with no id cannot be reconciled, the delete keys on
      // it, and letting one through renders metadata->>'qb_id' in () (or
      // worse, a bare comma alongside real ids), a SQL syntax error that
      // rolls back every chunk already committed in this entity type's
      // batch. Skipping it loses one row; letting it through loses all of
      // them.
      const transactions = fetched.filter((tx) => typeof tx.Id === 'string' && tx.Id.length > 0);
      const dropped = fetched.length - transactions.length;
      if (dropped > 0) {
        logger.warn({ orgId, entityType, dropped }, 'QB transaction missing a usable Id, skipped');
      }
      if (transactions.length === 0) continue;

      const normalized = normalizeTransactions(transactions, entityType);
      const fetchedTxnIds = transactions.map((tx) => tx.Id);
      const { upserted, reconciled } = await upsertRows(
        orgId,
        dataset.id,
        entityType,
        fetchedTxnIds,
        normalized,
      );
      totalRows += upserted;

      logger.info(
        { orgId, entityType, fetched: fetched.length, upserted, reconciled },
        'QB entity synced',
      );
    }

    if (isInitial) {
      await orgsQueries.setActiveDataset(orgId, dataset.id, dbAdmin);
    }

    await aiSummariesQueries.markStale(orgId, dbAdmin);

    await syncJobsQueries.update(
      job.id,
      {
        status: 'completed',
        completedAt: new Date(),
        rowsSynced: totalRows,
      },
      dbAdmin,
    );

    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'idle', null, dbAdmin);
    await integrationConnectionsQueries.updateLastSyncedAt(connection.id, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNCED, {
        provider: 'quickbooks',
        trigger,
        rowsSynced: totalRows,
      });
    }

    logger.info({ orgId, trigger, rowsSynced: totalRows }, 'QB sync completed');

    return { rowsSynced: totalRows, datasetId: dataset.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown sync error';

    await syncJobsQueries.update(
      job.id,
      {
        status: 'failed',
        completedAt: new Date(),
        error: message,
      },
      dbAdmin,
    );

    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'error', message, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin).catch(() => null);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNC_FAILED, {
        provider: 'quickbooks',
        trigger,
        error: message,
      });
    }

    logger.error({ orgId, trigger, err }, 'QB sync failed');
    throw err;
  }
}

async function findOrCreateQbDataset(orgId: number, companyName: string) {
  const datasetName = `QuickBooks, ${companyName}`;
  const existing = (await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin)).find(
    (ds) => ds.sourceType === 'quickbooks',
  );

  if (existing) {
    if (existing.name !== datasetName) {
      await datasetsQueries.updateDatasetName(orgId, existing.id, datasetName, dbAdmin);
    }
    return existing;
  }

  return datasetsQueries.createDataset(
    orgId,
    { name: datasetName, sourceType: 'quickbooks' },
    dbAdmin,
  );
}

export interface UpsertResult {
  upserted: number;
  reconciled: number;
}

// Groups fetchedTxnIds into chunks where neither the id count nor the
// accumulated produced-row count for that chunk's own transactions can
// exceed its budget, whichever limit a given id would hit first. A
// transaction is never split across two chunks, so a single transaction
// whose own row count alone exceeds DELETE_ROW_BUDGET (QuickBooks allows
// up to 750 line items on a taxable invoice) still gets a chunk of its
// own rather than straddling a boundary; that chunk's parameter count stays
// trivial regardless, since it carries only that one id.
function chunkFetchedIds(ids: string[], rowCountByQbId: Map<string, number>): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentRowCount = 0;

  for (const id of ids) {
    const idRowCount = rowCountByQbId.get(id) ?? 0;
    const wouldOverflow =
      current.length >= DELETE_ID_BATCH_SIZE || currentRowCount + idRowCount > DELETE_ROW_BUDGET;

    if (current.length > 0 && wouldOverflow) {
      chunks.push(current);
      current = [];
      currentRowCount = 0;
    }

    current.push(id);
    currentRowCount += idRowCount;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Batched upsert against (org_id, source_id), plus reconciliation: a row
 * from this batch's fetched transactions that the normalizer no longer
 * produces gets deleted, in the same transaction as the insert. Without
 * this, a transaction that now produces fewer rows (or none) leaves its
 * stale rows behind forever, since upsertRows never used to delete anything.
 *
 * Scoped to source_type = 'quickbooks' (metadata is untyped jsonb on a
 * shared table), to entityType (QuickBooks allocates Id per entity type, so
 * an Invoice and a Purchase can share the same Id, and qb_id alone would
 * match both), and to fetchedTxnIds (this batch's transactions, not the
 * whole dataset), since sync.ts fetches incrementally and a dataset-wide
 * diff would read every unchanged transaction as deleted.
 *
 * The delete runs in chunks built by chunkFetchedIds, each paired with only
 * the produced source ids for that chunk's own transactions (keyed off
 * metadata.qb_id, the same id every row's sourceId is built from), not the
 * full produced set. Chunking only the id list and leaving the produced-set
 * predicate unchunked raises the parameter ceiling instead of removing it.
 * All chunks run inside the one transaction the caller gets, so the
 * per-batch atomicity still holds across every statement.
 */
export async function upsertRows(
  orgId: number,
  datasetId: number,
  entityType: QbTransactionType,
  fetchedTxnIds: string[],
  rows: NormalizedQbRow[],
): Promise<UpsertResult> {
  // Deduplicated so a transaction STARTPOSITION-paginated into two pages
  // can't double-count toward the per-statement budget, and so the chunks
  // below partition the id space into disjoint sets with no id repeated
  // across two statements.
  const uniqueFetchedTxnIds = [...new Set(fetchedTxnIds)];
  if (uniqueFetchedTxnIds.length === 0) return { upserted: 0, reconciled: 0 };

  // rows gets the same pagination-duplicate treatment as fetchedTxnIds
  // above: the dedupe there covers which ids get asked about, not how many
  // times one transaction's own rows count toward this chunk's budget.
  // Keeps the later occurrence, since a transaction STARTPOSITION
  // pagination hands back twice reflects whatever changed between the two
  // fetches on its second appearance.
  const dedupedRows = Array.from(new Map(rows.map((row) => [row.sourceId, row])).values());

  const sourceIdsByQbId = new Map<string, string[]>();
  for (const row of dedupedRows) {
    const existing = sourceIdsByQbId.get(row.metadata.qb_id);
    if (existing) existing.push(row.sourceId);
    else sourceIdsByQbId.set(row.metadata.qb_id, [row.sourceId]);
  }
  const rowCountByQbId = new Map(
    Array.from(sourceIdsByQbId, ([qbId, sourceIds]) => [qbId, sourceIds.length] as const),
  );

  return dbAdmin.transaction(async (tx) => {
    let reconciled = 0;

    for (const idChunk of chunkFetchedIds(uniqueFetchedTxnIds, rowCountByQbId)) {
      const producedForChunk = idChunk.flatMap((id) => sourceIdsByQbId.get(id) ?? []);

      const deleted = await tx
        .delete(dataRows)
        .where(
          and(
            eq(dataRows.orgId, orgId),
            eq(dataRows.datasetId, datasetId),
            eq(dataRows.sourceType, 'quickbooks'),
            eq(sql`${dataRows.metadata}->>'txnType'`, entityType),
            inArray(sql`${dataRows.metadata}->>'qb_id'`, idChunk),
            notInArray(dataRows.sourceId, producedForChunk),
          ),
        )
        .returning({ id: dataRows.id });

      reconciled += deleted.length;
    }

    let upserted = 0;

    for (let i = 0; i < dedupedRows.length; i += INSERT_BATCH_SIZE) {
      const chunk = dedupedRows.slice(i, i + INSERT_BATCH_SIZE);
      const values = chunk.map((row) => ({
        orgId,
        datasetId,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        category: row.category,
        parentCategory: row.parentCategory,
        date: row.date,
        amount: row.amount,
        label: row.label,
        metadata: row.metadata,
      }));

      const result = await tx
        .insert(dataRows)
        .values(values)
        .onConflictDoUpdate({
          target: [dataRows.orgId, dataRows.sourceId],
          targetWhere: sql`${dataRows.sourceId} IS NOT NULL`,
          set: {
            amount: sql`excluded.amount`,
            date: sql`excluded.date`,
            category: sql`excluded.category`,
            parentCategory: sql`excluded.parent_category`,
            label: sql`excluded.label`,
            metadata: sql`excluded.metadata`,
          },
        })
        .returning({ id: dataRows.id });

      upserted += result.length;
    }

    return { upserted, reconciled };
  });
}
