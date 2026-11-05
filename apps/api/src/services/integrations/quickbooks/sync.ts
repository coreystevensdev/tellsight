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

const UPSERT_BATCH_SIZE = 500;

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
 * shared table) and to fetchedTxnIds (this batch's transactions, not the
 * whole dataset), since sync.ts fetches incrementally and a dataset-wide
 * diff would read every unchanged transaction as deleted.
 */
export async function upsertRows(
  orgId: number,
  datasetId: number,
  fetchedTxnIds: string[],
  rows: NormalizedQbRow[],
): Promise<UpsertResult> {
  if (fetchedTxnIds.length === 0) return { upserted: 0, reconciled: 0 };

  const producedSourceIds = rows.map((row) => row.sourceId);

  return dbAdmin.transaction(async (tx) => {
    const deleted = await tx
      .delete(dataRows)
      .where(
        and(
          eq(dataRows.orgId, orgId),
          eq(dataRows.datasetId, datasetId),
          eq(dataRows.sourceType, 'quickbooks'),
          inArray(sql`${dataRows.metadata}->>'qb_id'`, fetchedTxnIds),
          notInArray(dataRows.sourceId, producedSourceIds),
        ),
      )
      .returning({ id: dataRows.id });

    let upserted = 0;

    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
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

    return { upserted, reconciled: deleted.length };
  });
}
