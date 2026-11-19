import { integrationConnectionsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { enqueueSyncJob as enqueuePlaid } from './plaid/worker.js';
import { enqueueSyncJob as enqueueShopify } from './shopify/worker.js';
import { enqueueSyncJob as enqueueSquare } from './square/worker.js';
import { enqueueSyncJob as enqueueQuickBooks } from './worker.js';

/**
 * Re-fetches everything a connector can see, without the owner reconnecting.
 *
 * Exists because `'initial'` is the only trigger that fetches without a `since`
 * filter, and only the OAuth callback sends it. Scheduled and manual syncs ask
 * the provider for what changed, and a settled ledger changes nothing, so any
 * column added after a connection was made stays null on historical rows while
 * every nightly sync reports success. `data_rows.counterparty` sat at 0 of 142
 * that way for three days (DW-292).
 *
 * The alternative was disconnect-and-reconnect, which re-runs OAuth and is
 * visible to the owner, or a script against a production container. Neither is
 * something to reach for the next time a column lands.
 *
 * A `Record` keyed on the provider rather than a switch with a default, for the
 * reason `SEES_OPERATING_COST` is one: adding a connector without a resync path
 * should fail to compile rather than fall through to a no-op.
 */
const ENQUEUE_BACKFILL: Record<ResyncProvider, (connectionId: number) => Promise<void>> = {
  quickbooks: (id) => enqueueQuickBooks(id, 'backfill'),
  shopify: (id) => enqueueShopify(id, 'backfill'),
  square: (id) => enqueueSquare(id, 'backfill'),
  plaid: (id) => enqueuePlaid(id, 'backfill'),
};

export const RESYNC_PROVIDERS = ['quickbooks', 'shopify', 'square', 'plaid'] as const;

export type ResyncProvider = (typeof RESYNC_PROVIDERS)[number];

export function isResyncProvider(value: string): value is ResyncProvider {
  return (RESYNC_PROVIDERS as readonly string[]).includes(value);
}

export interface ResyncResult {
  connectionId: number;
}

/**
 * Returns null when the org has no connection for that provider, which the
 * caller turns into a 404. Deliberately not an error: asking to resync a
 * connector an org never connected is a wrong request, not a failure.
 */
export async function enqueueBackfill(
  orgId: number,
  provider: ResyncProvider,
): Promise<ResyncResult | null> {
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(
    orgId,
    provider,
    dbAdmin,
  );
  if (!connection) return null;

  await ENQUEUE_BACKFILL[provider](connection.id);
  logger.info({ orgId, provider, connectionId: connection.id }, 'Enqueued connector backfill');
  return { connectionId: connection.id };
}
