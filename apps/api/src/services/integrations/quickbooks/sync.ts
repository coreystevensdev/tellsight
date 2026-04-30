import { sql } from 'drizzle-orm';
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
import { normalizeTransactions } from './normalize.js';
import type { NormalizedQbRow, QbTransaction, QbTransactionType } from './types.js';

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
  'Estimate',
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
export async function runSync(
  connectionId: number,
  trigger: SyncTrigger,
): Promise<SyncResult> {
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(
    connectionId,
    'quickbooks',
  );
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const orgId = connection.orgId;
  const isInitial = trigger === 'initial';
  const since = isInitial ? undefined : connection.lastSyncedAt ?? undefined;

  const job = await syncJobsQueries.create({
    orgId,
    connectionId: connection.id,
    trigger,
    status: 'running',
    startedAt: new Date(),
  }, dbAdmin);

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
      const affected = await upsertRows(orgId, dataset.id, normalized);
      totalRows += affected;

      logger.info(
        { orgId, entityType, fetched: transactions.length, upserted: affected },
        'QB entity synced',
      );
    }

    if (isInitial) {
      await orgsQueries.setActiveDataset(orgId, dataset.id, dbAdmin);
    }

    await aiSummariesQueries.markStale(orgId, dbAdmin);

    await syncJobsQueries.update(job.id, {
      status: 'completed',
      completedAt: new Date(),
      rowsSynced: totalRows,
    }, dbAdmin);

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

    await syncJobsQueries.update(job.id, {
      status: 'failed',
      completedAt: new Date(),
      error: message,
    }, dbAdmin);

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

/**
 * Batched upsert against (org_id, source_id). Updates amount, date,
 * category, parentCategory, label, and metadata on conflict.
 * Returns the number of rows affected (inserted + updated).
 */
export async function upsertRows(
  orgId: number,
  datasetId: number,
  rows: NormalizedQbRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let affected = 0;

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

    const result = await dbAdmin
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

    affected += result.length;
  }

  return affected;
}
