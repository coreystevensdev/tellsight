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
import { createShopifyClient, paginateAll } from './api.js';
import { ConnectionNotFoundError } from './errors.js';
import { normalizeOrders, normalizeProducts } from './normalize.js';
import type { NormalizedShopifyRow, ShopifyOrder, ShopifyProduct } from './types.js';

const PAGE_SIZE = 50;
const UPSERT_BATCH_SIZE = 500;

export type SyncTrigger = 'initial' | 'scheduled' | 'manual';

export interface SyncResult {
  rowsSynced: number;
  datasetId: number;
}

const ORDERS_QUERY = `
  query OrdersSync($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          name
          createdAt
          updatedAt
          displayFinancialStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          customer { displayName }
          lineItems(first: 50) {
            edges { node { id title quantity originalTotalSet { shopMoney { amount currencyCode } } } }
          }
          refunds {
            id
            createdAt
            note
            totalRefundedSet { shopMoney { amount currencyCode } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCTS_QUERY = `
  query ProductsSync($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          updatedAt
          productType
          totalInventory
          variants(first: 50) {
            edges { node { id title price inventoryQuantity } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface OrdersConnection {
  orders: { edges: { node: ShopifyOrder }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

interface ProductsConnection {
  products: { edges: { node: ShopifyProduct }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

/**
 * Orchestrates a full Shopify sync: fetch orders + refunds + product
 * inventory → normalize → upsert → mark-stale. Same shape as QuickBooks'
 * runSync, minus the per-entity-type loop (Shopify only has two resource
 * kinds worth syncing here, not thirteen).
 */
export async function runSync(connectionId: number, trigger: SyncTrigger): Promise<SyncResult> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(connectionId, 'shopify');
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const orgId = connection.orgId;
  const isInitial = trigger === 'initial';
  const since = isInitial ? undefined : connection.lastSyncedAt ?? undefined;
  const syncedAt = new Date();

  const job = await syncJobsQueries.create(
    { orgId, connectionId: connection.id, trigger, status: 'running', startedAt: syncedAt },
    dbAdmin,
  );

  await integrationConnectionsQueries.updateSyncStatus(connection.id, 'syncing', null, dbAdmin);

  try {
    const client = await createShopifyClient(connectionId);
    const { shopName } = await client.getShopInfo();

    const dataset = await findOrCreateShopifyDataset(orgId, shopName);

    const dateFilter = since ? `updated_at:>${since.toISOString()}` : undefined;

    const orders = await paginateAll<ShopifyOrder>(
      client,
      ORDERS_QUERY,
      (data) => (data as OrdersConnection).orders,
      { first: PAGE_SIZE, query: dateFilter },
    );
    const normalizedOrders = normalizeOrders(orders);
    const orderRowsAffected = await upsertRows(orgId, dataset.id, normalizedOrders);

    const products = await paginateAll<ShopifyProduct>(
      client,
      PRODUCTS_QUERY,
      (data) => (data as ProductsConnection).products,
      { first: PAGE_SIZE, query: dateFilter },
    );
    const normalizedProducts = normalizeProducts(products, syncedAt);
    const productRowsAffected = await upsertRows(orgId, dataset.id, normalizedProducts);

    const totalRows = orderRowsAffected + productRowsAffected;

    logger.info(
      { orgId, orders: orders.length, products: products.length, rowsAffected: totalRows },
      'Shopify entities synced',
    );

    if (isInitial) {
      await orgsQueries.setActiveDataset(orgId, dataset.id, dbAdmin);
    }

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
        provider: 'shopify',
        trigger,
        rowsSynced: totalRows,
      });
    }

    logger.info({ orgId, trigger, rowsSynced: totalRows }, 'Shopify sync completed');

    return { rowsSynced: totalRows, datasetId: dataset.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown sync error';

    await syncJobsQueries.update(job.id, { status: 'failed', completedAt: new Date(), error: message }, dbAdmin);
    await integrationConnectionsQueries.updateSyncStatus(connection.id, 'error', message, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin).catch(() => null);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.INTEGRATION_SYNC_FAILED, {
        provider: 'shopify',
        trigger,
        error: message,
      });
    }

    logger.error({ orgId, trigger, err }, 'Shopify sync failed');
    throw err;
  }
}

async function findOrCreateShopifyDataset(orgId: number, shopName: string) {
  const datasetName = `Shopify, ${shopName}`;
  const existing = (await datasetsQueries.getDatasetsByOrg(orgId, dbAdmin)).find(
    (ds) => ds.sourceType === 'shopify',
  );

  if (existing) {
    if (existing.name !== datasetName) {
      await datasetsQueries.updateDatasetName(orgId, existing.id, datasetName, dbAdmin);
    }
    return existing;
  }

  return datasetsQueries.createDataset(orgId, { name: datasetName, sourceType: 'shopify' }, dbAdmin);
}

/**
 * Batched upsert against (org_id, source_id), same shape as QuickBooks'
 * upsertRows. Updates amount, date, category, parentCategory, label, and
 * metadata on conflict. Returns the number of rows affected.
 */
export async function upsertRows(
  orgId: number,
  datasetId: number,
  rows: NormalizedShopifyRow[],
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
