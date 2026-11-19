import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { ANALYTICS_EVENTS } from 'shared/constants';

import {
  aiSummariesQueries,
  datasetsQueries,
  integrationConnectionsQueries,
  orgsQueries,
  syncJobsQueries,
  userOrgsQueries,
} from '../../../db/queries/index.js';
import { dataRows } from '../../../db/schema.js';
import { dbAdmin } from '../../../lib/db.js';
import { logger } from '../../../lib/logger.js';
import { trackEvent } from '../../analytics/trackEvent.js';
import { createXeroClient } from './api.js';
import { XeroConnectionNotFoundError } from './errors.js';
import { normalizeTransactions } from './normalize.js';
import type { NormalizedXeroRow, XeroEntity } from './types.js';

/**
 * Payments are deliberately absent.
 *
 * In Xero a `Payment` settles an invoice that `Invoices` already reported, so
 * fetching both counts the same revenue twice. The QuickBooks connector has to
 * untangle this at normalize time, with a LinkedTxn rule and an UnappliedAmt
 * rule, because Intuit's Payment can carry money no invoice recorded. Xero
 * splits the two cleanly instead: invoice-backed money is a Payment, and money
 * with no invoice behind it is a BankTransaction. Fetching invoices and bank
 * transactions therefore covers both without overlapping, and no de-duplication
 * rule is needed at all.
 */
const ENTITIES: XeroEntity[] = ['Invoices', 'BankTransactions', 'CreditNotes'];

// Same ceiling and the same two dimensions as the QuickBooks sync: postgres.js
// refuses a statement over 65,533 bind parameters, and the delete carries an id
// list plus the produced-row list for those ids. The budgets are copied from
// the measurement taken there (500 ids averaging 130 rows each is 65,504
// parameters and succeeds, 131 throws) rather than measured against Xero, whose
// per-invoice line ceiling this has not been tested against.
const INSERT_BATCH_SIZE = 500;
const DELETE_ID_BATCH_SIZE = 500;
const DELETE_ROW_BUDGET = 500;

export type SyncTrigger = 'initial' | 'scheduled' | 'manual' | 'backfill';

export interface SyncResult {
  rowsSynced: number;
  datasetId: number;
}

export async function runSync(connectionId: number, trigger: SyncTrigger): Promise<SyncResult> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'xero',
    dbAdmin,
  );
  if (!connection) throw new XeroConnectionNotFoundError(connectionId);

  const orgId = connection.orgId;
  const isInitial = trigger === 'initial';
  // A backfill needs the same wide fetch an initial sync does without the other
  // thing isInitial means, since setActiveDataset below would move an org off
  // the dataset it is looking at.
  const wantsEverything = isInitial || trigger === 'backfill';
  // If-Modified-Since is modification-based, so a settled ledger reports
  // nothing changed and any column added after a connection was made stays null
  // on historical rows while every nightly sync succeeds. That is exactly how
  // counterparty sat at 0 of 142 for three days (DW-292), which is what the
  // backfill trigger exists to undo.
  const modifiedSince = wantsEverything ? undefined : (connection.lastSyncedAt ?? undefined);

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
    const client = await createXeroClient(connectionId);

    // Non-fatal: an empty map degrades every category to its account code,
    // which is poor labelling, where throwing would discard a sync's worth of
    // transactions over a lookup that only renames things.
    let accountNames = new Map<string, string>();
    try {
      accountNames = await client.fetchAccountNames();
    } catch (err) {
      logger.warn({ orgId, connectionId, err }, 'Xero accounts lookup failed, using account codes');
    }

    // Same call, same reasoning: a dataset label is not worth losing a sync
    // over, so a failure here names the dataset 'Xero' instead of throwing.
    let organisationName: string | null = null;
    try {
      organisationName = await client.fetchOrganisationName();
    } catch (err) {
      logger.warn({ orgId, connectionId, err }, 'Xero organisation lookup failed');
    }

    const dataset = await findOrCreateXeroDataset(orgId, organisationName);

    let totalRows = 0;

    for (const entity of ENTITIES) {
      const fetched = await client.fetchEntity(entity, modifiedSince);
      if (fetched.length === 0) continue;

      const normalized = normalizeTransactions(fetched, entity, accountNames);
      const fetchedIds = fetched.map((tx) => tx.id);

      const { upserted, reconciled } = await upsertRows(
        orgId,
        dataset.id,
        entity,
        fetchedIds,
        normalized,
      );
      totalRows += upserted;

      logger.info(
        { orgId, entity, fetched: fetched.length, upserted, reconciled },
        'Xero entity synced',
      );
    }

    if (isInitial) {
      await orgsQueries.setActiveDataset(orgId, dataset.id, dbAdmin);
    }

    await datasetsQueries.touchDataRefreshed(orgId, dataset.id, dbAdmin);
    await aiSummariesQueries.markStale(orgId, dbAdmin);

    await syncJobsQueries.update(
      job.id,
      { status: 'completed', completedAt: new Date(), rowsSynced: totalRows },
      dbAdmin,
    );

    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'idle', null, dbAdmin);
    await integrationConnectionsQueries.updateLastSyncedAt(connection.id, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNCED, {
        provider: 'xero',
        trigger,
        rowsSynced: totalRows,
      });
    }

    logger.info({ orgId, trigger, rowsSynced: totalRows }, 'Xero sync completed');

    return { rowsSynced: totalRows, datasetId: dataset.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown sync error';

    await syncJobsQueries.update(
      job.id,
      { status: 'failed', completedAt: new Date(), error: message },
      dbAdmin,
    );
    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'error', message, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin).catch(() => null);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNC_FAILED, {
        provider: 'xero',
        trigger,
        error: message,
      });
    }

    logger.error({ orgId, trigger, err }, 'Xero sync failed');
    throw err;
  }
}

async function findOrCreateXeroDataset(orgId: number, organisationName: string | null) {
  // Falls back to the provider name rather than the tenant GUID: "Xero,
  // 70784a63-d24b-46a9" is worse than no detail at all on a dashboard.
  const datasetName = organisationName ? `Xero, ${organisationName}` : 'Xero';

  const existing = (await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin)).find(
    (ds) => ds.sourceType === 'xero',
  );

  if (existing) {
    if (existing.name !== datasetName) {
      await datasetsQueries.updateDatasetName(orgId, existing.id, datasetName, dbAdmin);
    }
    return existing;
  }

  return datasetsQueries.createDataset(orgId, { name: datasetName, sourceType: 'xero' }, dbAdmin);
}

export interface UpsertResult {
  upserted: number;
  reconciled: number;
}

// Partitions ids so that neither the id count nor the produced-row count for
// that chunk's own transactions can exceed its budget. A transaction is never
// split across chunks, so one invoice whose own lines exceed the row budget
// still gets a chunk to itself rather than straddling a boundary.
function chunkFetchedIds(ids: string[], rowCountById: Map<string, number>): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentRowCount = 0;

  for (const id of ids) {
    const idRowCount = rowCountById.get(id) ?? 0;
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
 * Batched upsert against (org_id, source_id), plus reconciliation: a row this
 * batch's transactions used to produce and no longer does gets deleted in the
 * same transaction as the insert. Without it, an invoice that loses a line
 * leaves that line's row behind forever.
 *
 * Scoped to source_type = 'xero', to the entity (metadata is untyped jsonb on a
 * shared table), and to the ids in this batch rather than the whole dataset,
 * since an incremental sync returns only what changed and a dataset-wide diff
 * would read every untouched transaction as deleted.
 *
 * Every column the insert sets is also named in the conflict clause. A sync
 * takes the conflict path for rows that already exist, so a column present only
 * in the insert values never lands on them, which is how counterparty stayed
 * null on 142 QuickBooks rows through three successful syncs.
 */
export async function upsertRows(
  orgId: number,
  datasetId: number,
  entity: XeroEntity,
  fetchedIds: string[],
  rows: NormalizedXeroRow[],
): Promise<UpsertResult> {
  const uniqueFetchedIds = [...new Set(fetchedIds)];
  if (uniqueFetchedIds.length === 0) return { upserted: 0, reconciled: 0 };

  // Keeps the later occurrence: a transaction returned on two pages reflects
  // whatever changed between the two fetches on its second appearance.
  const dedupedRows = Array.from(new Map(rows.map((row) => [row.sourceId, row])).values());

  const sourceIdsByXeroId = new Map<string, string[]>();
  for (const row of dedupedRows) {
    const existing = sourceIdsByXeroId.get(row.metadata.xero_id);
    if (existing) existing.push(row.sourceId);
    else sourceIdsByXeroId.set(row.metadata.xero_id, [row.sourceId]);
  }
  const rowCountById = new Map(
    Array.from(sourceIdsByXeroId, ([id, sourceIds]) => [id, sourceIds.length] as const),
  );

  return dbAdmin.transaction(async (tx) => {
    let reconciled = 0;

    for (const idChunk of chunkFetchedIds(uniqueFetchedIds, rowCountById)) {
      const producedForChunk = idChunk.flatMap((id) => sourceIdsByXeroId.get(id) ?? []);

      const deleted = await tx
        .delete(dataRows)
        .where(
          and(
            eq(dataRows.orgId, orgId),
            eq(dataRows.datasetId, datasetId),
            eq(dataRows.sourceType, 'xero'),
            eq(sql`${dataRows.metadata}->>'entity'`, entity),
            inArray(sql`${dataRows.metadata}->>'xero_id'`, idChunk),
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
        counterparty: row.counterparty,
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
            counterparty: sql`excluded.counterparty`,
            metadata: sql`excluded.metadata`,
          },
        })
        .returning({ id: dataRows.id });

      upserted += result.length;
    }

    return { upserted, reconciled };
  });
}
