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

// Governs both loops in upsertRows. postgres.js enforces a 65,533 total
// bind-parameter ceiling before a query reaches the wire (build.js:45), and
// 500 ids plus the rows they produce stays far under it even for a
// transaction with many lines, while matching the chunk size the insert
// side already used.
const BATCH_SIZE = 500;

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
      const transactions = (await client.query(entityType, since)) as QbTransaction[];
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
        { orgId, entityType, fetched: transactions.length, upserted, reconciled },
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
 * The delete runs in chunks of BATCH_SIZE fetched ids, each paired with
 * only the produced source ids for that chunk's own transactions (keyed off
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

  return dbAdmin.transaction(async (tx) => {
    let reconciled = 0;

    for (let i = 0; i < uniqueFetchedTxnIds.length; i += BATCH_SIZE) {
      const idChunk = uniqueFetchedTxnIds.slice(i, i + BATCH_SIZE);
      const idChunkSet = new Set(idChunk);
      const producedForChunk = rows
        .filter((row) => idChunkSet.has(row.metadata.qb_id))
        .map((row) => row.sourceId);

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

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
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
