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
import { createSquareClient } from './api.js';
import { ConnectionNotFoundError } from './errors.js';
import { normalizeOrders } from './normalize.js';
import type { NormalizedSquareRow, SquareLocation } from './types.js';

const UPSERT_BATCH_SIZE = 500;

// SearchOrders needs a start date, so an initial sync cannot simply ask for
// everything. Two years is what the dashboard's year-over-year comparisons
// actually read, and it bounds the first sync for a seller with years of
// history behind them.
const INITIAL_LOOKBACK_MONTHS = 24;

export type SyncTrigger = 'initial' | 'scheduled' | 'manual';

export interface SyncResult {
  rowsSynced: number;
  datasetId: number;
}

// One location is worth naming; several are not worth listing in a dataset
// title that has to fit on a card.
function datasetNameFor(locations: SquareLocation[], merchantId: string): string {
  if (locations.length === 1) {
    const name = locations[0]!.name?.trim();
    if (name) return `Square, ${name}`;
  }
  if (locations.length > 1) return `Square, ${locations.length} locations`;
  return `Square, ${merchantId}`;
}

export async function runSync(connectionId: number, trigger: SyncTrigger): Promise<SyncResult> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'square',
    dbAdmin,
  );
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const orgId = connection.orgId;
  const isInitial = trigger === 'initial';
  const syncedAt = new Date();

  const since =
    !isInitial && connection.lastSyncedAt
      ? connection.lastSyncedAt
      : new Date(
          Date.UTC(syncedAt.getUTCFullYear(), syncedAt.getUTCMonth() - INITIAL_LOOKBACK_MONTHS, 1),
        );

  const job = await syncJobsQueries.create(
    { orgId, connectionId: connection.id, trigger, status: 'running', startedAt: syncedAt },
    dbAdmin,
  );

  await integrationConnectionsQueries.updateSyncStatus(connection.id, 'syncing', null, dbAdmin);

  try {
    const client = await createSquareClient(connectionId);

    // Has to come first: the token covers every location but names none, and
    // SearchOrders will not take an empty list.
    const locations = await client.listLocations();
    const dataset = await findOrCreateSquareDataset(
      orgId,
      datasetNameFor(locations, connection.providerTenantId),
    );

    const orders = await client.searchOrders(
      locations.map((l) => l.id),
      since,
    );
    const rows = normalizeOrders(orders);
    const rowsAffected = await upsertRows(orgId, dataset.id, rows);

    logger.info(
      { orgId, locations: locations.length, orders: orders.length, rowsAffected },
      'Square orders synced',
    );

    // The initial sync claims the dashboard. A scheduled or manual one does not,
    // so a background run cannot swap the dataset out from under someone
    // mid-session. But if the org has no active dataset there is nothing to
    // protect, and without this an org whose initial sync failed can never
    // display the data it now holds: only an initial run sets this, and only
    // reconnecting produces another one.
    const org = await orgsQueries.findOrgById(orgId, dbAdmin);
    if (isInitial || !org?.activeDatasetId) {
      await orgsQueries.setActiveDataset(orgId, dataset.id, dbAdmin);
    }

    await aiSummariesQueries.markStale(orgId, dbAdmin);

    await syncJobsQueries.update(
      job.id,
      { status: 'completed', completedAt: new Date(), rowsSynced: rowsAffected },
      dbAdmin,
    );

    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'idle', null, dbAdmin);
    await integrationConnectionsQueries.updateLastSyncedAt(connection.id, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNCED, {
        provider: 'square',
        trigger,
        rowsSynced: rowsAffected,
      });
    }

    logger.info({ orgId, trigger, rowsSynced: rowsAffected }, 'Square sync completed');

    return { rowsSynced: rowsAffected, datasetId: dataset.id };
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
        provider: 'square',
        trigger,
        error: message,
      });
    }

    logger.error({ orgId, trigger, err }, 'Square sync failed');
    throw err;
  }
}

async function findOrCreateSquareDataset(orgId: number, datasetName: string) {
  const existing = (await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin)).find(
    (ds) => ds.sourceType === 'square',
  );

  if (existing) {
    if (existing.name !== datasetName) {
      await datasetsQueries.updateDatasetName(orgId, existing.id, datasetName, dbAdmin);
    }
    return existing;
  }

  return datasetsQueries.createDataset(orgId, { name: datasetName, sourceType: 'square' }, dbAdmin);
}

export async function upsertRows(
  orgId: number,
  datasetId: number,
  rows: NormalizedSquareRow[],
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
