import { and, eq, inArray, sql } from 'drizzle-orm';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { dbAdmin } from '../../../lib/db.js';
import { logger } from '../../../lib/logger.js';
import { dataRows } from '../../../db/schema.js';
import {
  integrationConnectionsQueries,
  syncJobsQueries,
  datasetsQueries,
  aiSummariesQueries,
  orgFinancialsQueries,
  userOrgsQueries,
} from '../../../db/queries/index.js';
import { trackEvent } from '../../analytics/trackEvent.js';
import { decrypt } from '../encryption.js';
import { fetchAccountBalances, fetchTransactionsSince } from './api.js';
import { cashFromAccounts } from './balances.js';
import { PlaidConnectionNotFoundError, PlaidCursorInvalidError } from './errors.js';
import { normalizePlaidTransactions } from './normalize.js';
import type { NormalizedPlaidRow } from './normalize.js';
import type { PlaidSyncOutcome, PlaidSyncTrigger } from './types.js';

// Postgres caps a statement at 65535 parameters. A removal list is normally a
// handful, but an Item reset can hand back a lot at once, so the delete is
// chunked rather than trusting it to stay small.
const DELETE_ID_CHUNK = 1_000;

async function findOrCreatePlaidDataset(orgId: number, institutionName: string) {
  const datasetName = `Bank, ${institutionName}`;
  const existing = (await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin)).find(
    (ds) => ds.sourceType === 'plaid',
  );

  if (existing) {
    if (existing.name !== datasetName) {
      await datasetsQueries.updateDatasetName(orgId, existing.id, datasetName, dbAdmin);
    }
    return existing;
  }

  return datasetsQueries.createDataset(orgId, { name: datasetName, sourceType: 'plaid' }, dbAdmin);
}

/**
 * Writes one sync's worth of changes, and the cursor that accounts for them, in
 * a single transaction.
 *
 * The reconciliation delete is far simpler than the QuickBooks one it is modelled
 * on, and for a structural reason worth keeping: a Plaid transaction maps to
 * exactly one row whose `source_id` is the transaction id, so a removal is a
 * plain `IN` against an indexed column. QuickBooks needs two-dimensional
 * chunking because one transaction produces many rows and its id only exists
 * inside `metadata`.
 */
export async function writeChanges(
  orgId: number,
  datasetId: number,
  connectionId: number,
  rows: NormalizedPlaidRow[],
  removedIds: string[],
  cursor: string,
): Promise<{ upserted: number; removed: number }> {
  // Plaid can report a transaction in `modified` that also arrived in `added`
  // during the same walk across pages. Keeping the later one matches what the
  // final page says about it.
  const deduped = Array.from(new Map(rows.map((r) => [r.sourceId, r])).values());

  // A row rewritten this sync must not then be deleted by a stale removal in the
  // same batch.
  const writtenIds = new Set(deduped.map((r) => r.sourceId));
  const toRemove = [...new Set(removedIds)].filter((id) => !writtenIds.has(id));

  let removed = 0;

  await dbAdmin.transaction(async (tx) => {
    if (deduped.length > 0) {
      await tx
        .insert(dataRows)
        .values(
          deduped.map((row) => ({
            orgId,
            datasetId,
            sourceType: 'plaid' as const,
            sourceId: row.sourceId,
            category: row.category,
            parentCategory: row.parentCategory,
            date: row.date,
            amount: row.amount,
            counterparty: row.counterparty,
            label: row.label,
            metadata: row.metadata,
          })),
        )
        .onConflictDoUpdate({
          target: [dataRows.orgId, dataRows.sourceId],
          targetWhere: sql`${dataRows.sourceId} IS NOT NULL`,
          // Every column the normalizer produces, named one at a time. After the
          // first sync every row already exists and takes the conflict path, so a
          // column present only in the insert values never reaches an existing
          // row: that is how counterparty stayed 0 of 142 for a day on
          // QuickBooks. Plaid writes counterparty and metadata, so both are here.
          set: {
            amount: sql`excluded.amount`,
            date: sql`excluded.date`,
            category: sql`excluded.category`,
            parentCategory: sql`excluded.parent_category`,
            counterparty: sql`excluded.counterparty`,
            label: sql`excluded.label`,
            metadata: sql`excluded.metadata`,
          },
        });
    }

    for (let i = 0; i < toRemove.length; i += DELETE_ID_CHUNK) {
      const chunk = toRemove.slice(i, i + DELETE_ID_CHUNK);
      // org_id and dataset_id are each sufficient here, since a dataset belongs
      // to one org and findOrCreatePlaidDataset gives an org at most one Plaid
      // dataset. Neither is individually covered by a test for that reason:
      // removing either one leaves the other scoping the delete correctly, and
      // no reachable state tells them apart. Both stay as defense in depth.
      const deleted = await tx
        .delete(dataRows)
        .where(
          and(
            eq(dataRows.orgId, orgId),
            eq(dataRows.datasetId, datasetId),
            eq(dataRows.sourceType, 'plaid'),
            inArray(dataRows.sourceId, chunk),
          ),
        )
        .returning({ id: dataRows.id });
      removed += deleted.length;
    }

    // Connector syncs reuse one dataset and rewrite its rows, so created_at
    // freezes at first connect and cannot answer "is this data fresh" (DW-281).
    if (deduped.length > 0 || removed > 0) {
      await datasetsQueries.touchDataRefreshed(orgId, datasetId, tx);
    }

    // Last, and inside the transaction: the cursor asserts that everything
    // before it is persisted. Committed on its own it would mark transactions
    // seen that no row exists for, and nothing would fetch them again.
    await integrationConnectionsQueries.updateSyncCursor(connectionId, cursor, tx);
  });

  return { upserted: deduped.length, removed };
}

/**
 * Records what the bank says is on hand, so `runway` and `cash_forecast` have a
 * starting balance.
 *
 * Both stats read `financials.cashOnHand`, and until now the only way one got
 * set was an owner typing it, which no org has ever done: both stats have never
 * fired for anyone. `updateOrgFinancials` appends to `cash_balance_snapshots` in
 * the same transaction, so a bank-sourced figure replacing an owner-typed one
 * leaves the owner's value in the history rather than losing it.
 *
 * Deliberately non-fatal. Transactions are what the product is for, and a
 * balance endpoint failing must not discard a sync's worth of rows: the owner
 * would see a failed sync and no new data, for a number that is a bonus.
 */
async function recordCashOnHand(orgId: number, accessToken: string): Promise<void> {
  try {
    const { accounts } = await fetchAccountBalances(accessToken);
    const cash = cashFromAccounts(accounts);
    if (!cash) {
      logger.info({ orgId }, 'No single-currency depository balance to record');
      return;
    }

    // dbAdmin, not the default. This runs in a BullMQ worker with no request
    // context, so nothing has set app.current_org_id, and both tables it
    // touches carry a tenant policy: the snapshot insert is refused outright
    // with 42501 and the orgs update silently matches nothing. The whole write
    // is one transaction, so the refusal rolled back the profile merge too and
    // every sync logged the balance as unrecordable while reporting success.
    await orgFinancialsQueries.updateOrgFinancials(
      orgId,
      {
        cashOnHand: cash.balance,
        // Full ISO, not the date alone. `cashAsOfDate` is
        // `z.string().datetime()`, which rejects `YYYY-MM-DD`. A bank balance
        // is also a point in time rather than a day: two syncs in one afternoon
        // are two different answers.
        cashAsOfDate: new Date().toISOString(),
      },
      dbAdmin,
    );
    logger.info(
      { orgId, accountCount: cash.accountCount, currency: cash.currency },
      'Recorded cash on hand from bank balances',
    );
  } catch (err) {
    logger.warn({ orgId, err }, 'Could not record cash on hand, leaving the sync successful');
  }
}

export async function runSync(
  connectionId: number,
  trigger: PlaidSyncTrigger,
): Promise<PlaidSyncOutcome> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'plaid',
    dbAdmin,
  );
  if (!connection) throw new PlaidConnectionNotFoundError(connectionId);

  const orgId = connection.orgId;
  const job = await syncJobsQueries.create(
    { orgId, connectionId: connection.id, trigger, status: 'running', startedAt: new Date() },
    dbAdmin,
  );
  await integrationConnectionsQueries.updateSyncStatus(connection.id, 'syncing', null, dbAdmin);

  try {
    const accessToken = decrypt(connection.encryptedAccessToken);
    const dataset = await findOrCreatePlaidDataset(orgId, connection.providerTenantId);

    // Plaid is cursor-based, so a backfill means discarding the stored cursor
    // rather than widening a date window. Safe because every row is keyed by
    // transaction_id and upserted, so a full replay converges rather than
    // duplicating, which is the same property the cursor-rejected path relies on.
    const from = trigger === 'backfill' ? null : connection.syncCursor;

    let page;
    try {
      page = await fetchTransactionsSince(accessToken, from);
    } catch (err) {
      if (!(err instanceof PlaidCursorInvalidError)) throw err;
      // Plaid's documented recovery is to start over rather than retry the same
      // cursor. Reconciliation makes that safe: a full walk re-upserts every
      // transaction by id, so the replay converges instead of duplicating.
      logger.warn({ orgId, connectionId }, 'Plaid cursor rejected, resyncing from the start');
      page = await fetchTransactionsSince(accessToken, null);
    }

    const rows = normalizePlaidTransactions([...page.added, ...page.modified]);
    const { upserted, removed } = await writeChanges(
      orgId,
      dataset.id,
      connection.id,
      rows,
      page.removedIds,
      page.cursor,
    );

    await recordCashOnHand(orgId, accessToken);

    // New rows invalidate the cached summary. Without this the dashboard keeps
    // serving an interpretation of data that has since changed.
    await aiSummariesQueries.markStale(orgId, dbAdmin);

    await syncJobsQueries.update(
      job.id,
      { status: 'completed', completedAt: new Date(), rowsSynced: upserted },
      dbAdmin,
    );
    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'idle', null, dbAdmin);
    await integrationConnectionsQueries.updateLastSyncedAt(connection.id, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNCED, {
        provider: 'plaid',
        trigger,
        rowsSynced: upserted,
      });
    }

    logger.info({ orgId, connectionId, trigger, upserted, removed }, 'Plaid sync completed');
    return { rowsSynced: upserted, removed, cursor: page.cursor };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown sync error';

    await syncJobsQueries.update(
      job.id,
      { status: 'failed', completedAt: new Date(), error: message },
      dbAdmin,
    );
    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'error', message, dbAdmin);
    throw err;
  }
}
