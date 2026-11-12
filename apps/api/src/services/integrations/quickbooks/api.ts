import { env } from '../../../config.js';
import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { decrypt } from '../encryption.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { refreshAccessToken } from './oauth.js';
import {
  RetryableError,
  TokenRevokedError,
  QbApiError,
  ConnectionNotFoundError,
} from './errors.js';

const BASE_URLS = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
} as const;

const MAX_RESULTS = 1000;

// The loop below breaks on a short page, so an endpoint that always answers with
// a full one never terminates. Square's client already caps at 100 pages; this
// matches it. 100 x 1000 rows is far past any real company's month of activity.
export const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface QbClient {
  query(entityType: string, since?: Date): Promise<unknown[]>;
  getCompanyInfo(): Promise<{ companyName: string }>;
}

export async function createQbClient(connectionId: number): Promise<QbClient> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'quickbooks',
    dbAdmin,
  );
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const realmId = connection.providerTenantId;
  // Encoded here rather than trusted from the callback: rows written before the
  // callback validated the format are still in the table, and this value sits in
  // the path of every request carrying the org's access token.
  const realm = encodeURIComponent(realmId);
  const baseUrl = BASE_URLS[env.QUICKBOOKS_ENVIRONMENT ?? 'sandbox'];

  let accessToken = decrypt(connection.encryptedAccessToken);
  let expiresAt = connection.accessTokenExpiresAt;

  let refreshing: Promise<void> | null = null;

  async function ensureFreshToken() {
    if (expiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;

    if (refreshing) {
      await refreshing;
      return;
    }

    refreshing = (async () => {
      try {
        logger.info({ connectionId }, 'Refreshing QB access token');
        const result = await refreshAccessToken(connectionId);
        accessToken = decrypt(result.encryptedAccessToken);
        expiresAt = result.accessTokenExpiresAt;
      } finally {
        refreshing = null;
      }
    })();

    await refreshing;
  }

  async function qbFetch(url: string): Promise<Response> {
    await ensureFreshToken();

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) {
      throw new TokenRevokedError();
    }

    if (res.status === 429) {
      const body = await res.text();
      throw new RetryableError('QuickBooks rate limit exceeded', 429, body);
    }

    if (res.status >= 500) {
      const body = await res.text();
      throw new RetryableError(`QuickBooks server error: ${res.status}`, res.status, body);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new QbApiError(`QuickBooks API error: ${res.status}`, res.status, body);
    }

    return res;
  }

  return {
    async query(entityType: string, since?: Date): Promise<unknown[]> {
      const results: unknown[] = [];
      let startPosition = 1;
      let pages = 0;
      let truncated = false;

      while (true) {
        let sql = `SELECT * FROM ${entityType}`;
        if (since) {
          sql += ` WHERE MetaData.LastUpdatedTime > '${since.toISOString()}'`;
        }
        sql += ` STARTPOSITION ${startPosition} MAXRESULTS ${MAX_RESULTS}`;

        const url = `${baseUrl}/v3/company/${realm}/query?query=${encodeURIComponent(sql)}`;
        const res = await qbFetch(url);
        const data = (await res.json()) as { QueryResponse?: Record<string, unknown[]> };

        const rows = data.QueryResponse?.[entityType] ?? [];
        results.push(...rows);

        if (rows.length < MAX_RESULTS) break;
        pages += 1;
        if (pages >= MAX_PAGES) {
          truncated = true;
          break;
        }
        startPosition += MAX_RESULTS;
      }

      if (truncated) {
        logger.warn(
          { connectionId, entityType, pages, count: results.length },
          'QB query hit the page cap, results are incomplete',
        );
      }
      logger.info({ connectionId, entityType, count: results.length }, 'QB query complete');
      return results;
    },

    async getCompanyInfo(): Promise<{ companyName: string }> {
      const url = `${baseUrl}/v3/company/${realm}/companyinfo/${realm}`;
      const res = await qbFetch(url);
      const data = (await res.json()) as { CompanyInfo?: { CompanyName?: string } };
      return { companyName: data.CompanyInfo?.CompanyName ?? 'QuickBooks Company' };
    },
  };
}
