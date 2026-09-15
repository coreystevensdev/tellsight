import { logger } from '../../../lib/logger.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { decrypt } from '../encryption.js';
import { apiHost, refreshAccessToken } from './oauth.js';
import { ConnectionNotFoundError, RetryableError, SquareApiError, TokenRevokedError } from './errors.js';
import type { SquareLocation, SquareOrder } from './types.js';

const SQUARE_VERSION = '2026-08-19';
const REQUEST_TIMEOUT_MS = 20_000;

// Refresh this far ahead of expiry rather than waiting for a 401. Square access
// tokens last 30 days while refresh tokens never expire, so a connection idle
// for a month has a dead access token and a perfectly good refresh token; that
// is the ordinary case here, not an error worth a failed request first.
const TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000;

const MAX_PAGES = 100;

export interface SquareClient {
  listLocations(): Promise<SquareLocation[]>;
  searchOrders(locationIds: string[], since: Date): Promise<SquareOrder[]>;
}

export async function createSquareClient(connectionId: number): Promise<SquareClient> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(connectionId, 'square');
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  let accessToken = decrypt(connection.encryptedAccessToken);
  let expiresAt = connection.accessTokenExpiresAt;
  let refreshing: Promise<void> | null = null;

  async function ensureFreshToken() {
    if (expiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;
    if (refreshing) return refreshing;

    refreshing = (async () => {
      try {
        const result = await refreshAccessToken(connectionId);
        accessToken = decrypt(result.encryptedAccessToken);
        expiresAt = result.accessTokenExpiresAt;
      } finally {
        refreshing = null;
      }
    })();

    return refreshing;
  }

  async function call(path: string, init?: { method: string; body: unknown }): Promise<unknown> {
    await ensureFreshToken();

    const res = await fetch(`${apiHost()}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
      },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) throw new TokenRevokedError();

    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`Square ${path} returned ${res.status}`, res.status, await res.text());
    }

    if (!res.ok) {
      throw new SquareApiError(`Square ${path} returned ${res.status}`, res.status, await res.text());
    }

    return res.json();
  }

  return {
    // A Square token covers every location the seller runs but carries no
    // location id, and SearchOrders will not accept an empty list, so this has
    // to run before any order can be read.
    async listLocations() {
      const body = (await call('/v2/locations')) as { locations?: SquareLocation[] };
      const active = (body.locations ?? []).filter((l) => l.status !== 'INACTIVE');
      logger.info({ connectionId, locations: active.length }, 'Square locations resolved');
      return active;
    },

    async searchOrders(locationIds: string[], since: Date) {
      if (locationIds.length === 0) return [];

      const orders: SquareOrder[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const body = (await call('/v2/orders/search', {
          method: 'POST',
          body: {
            location_ids: locationIds,
            cursor,
            limit: 500,
            query: {
              filter: {
                date_time_filter: { updated_at: { start_at: since.toISOString() } },
                // Square requires a state filter whenever the sort field is
                // CLOSED_AT, and open tabs are not sales yet either way.
                state_filter: { states: ['COMPLETED'] },
              },
              sort: { sort_field: 'UPDATED_AT', sort_order: 'ASC' },
            },
          },
        })) as { orders?: SquareOrder[]; cursor?: string };

        orders.push(...(body.orders ?? []));
        cursor = body.cursor;
        pages += 1;
      } while (cursor && pages < MAX_PAGES);

      if (cursor) {
        // Silently returning a partial window would look like a quiet month.
        logger.warn({ connectionId, pages, orders: orders.length }, 'Square order paging hit its cap');
      }

      return orders;
    },
  };
}
