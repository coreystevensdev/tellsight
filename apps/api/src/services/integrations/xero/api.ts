import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { dbAdmin } from '../../../lib/db.js';
import { logger } from '../../../lib/logger.js';
import { decrypt } from '../encryption.js';
import { requireTokenExpiry } from '../tokenRotation.js';
import {
  XeroApiError,
  XeroConnectionNotFoundError,
  XeroRetryableError,
  XeroTokenRevokedError,
} from './errors.js';
import { refreshAccessToken } from './oauth.js';
import type { XeroEntity, XeroTransaction } from './types.js';

const BASE_URL = 'https://api.xero.com/api.xro/2.0';

// Xero's documented page size. The loop stops on a short page, so this value
// has to match what the API actually returns or a full final page reads as
// "there is more" forever; MAX_PAGES is the backstop either way.
const PAGE_SIZE = 100;
export const MAX_PAGES = 100;

const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// Xero allows 60 calls per minute per tenant and 5,000 a day. A sync is three
// entities plus one accounts lookup, so a typical small business is nowhere
// near either; this only exists so an org that does approach it says so in the
// logs before anyone has to guess.
const MIN_LIMIT_WARN_THRESHOLD = 10;

// The id field differs per entity and there is no shared one.
const ID_FIELD: Record<XeroEntity, string> = {
  Invoices: 'InvoiceID',
  BankTransactions: 'BankTransactionID',
  CreditNotes: 'CreditNoteID',
};

export interface XeroClient {
  fetchEntity(entity: XeroEntity, modifiedSince?: Date): Promise<XeroTransaction[]>;
  fetchAccountNames(): Promise<Map<string, string>>;
  fetchOrganisationName(): Promise<string | null>;
}

export async function createXeroClient(connectionId: number): Promise<XeroClient> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'xero',
    dbAdmin,
  );
  if (!connection) throw new XeroConnectionNotFoundError(connectionId);

  const tenantId = connection.providerTenantId;

  let accessToken = decrypt(connection.encryptedAccessToken);
  let expiresAt = requireTokenExpiry(connection);

  let refreshing: Promise<void> | null = null;

  // Collapses concurrent refreshes inside this client. The cross-instance race
  // is handled by the compare-and-set in tokenRotation.ts, which matters far
  // more for Xero than for QuickBooks because a lost race here destroys the
  // token (oauth.ts).
  async function ensureFreshToken() {
    if (expiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS) return;

    if (refreshing) {
      await refreshing;
      return;
    }

    refreshing = (async () => {
      try {
        logger.info({ connectionId }, 'Refreshing Xero access token');
        const result = await refreshAccessToken(connectionId);
        accessToken = decrypt(result.encryptedAccessToken);
        expiresAt = result.accessTokenExpiresAt;
      } finally {
        refreshing = null;
      }
    })();

    await refreshing;
  }

  async function xeroFetch(path: string, modifiedSince?: Date): Promise<unknown> {
    await ensureFreshToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      // Xero serves XML by default, so omitting this makes res.json() throw on
      // a response that was otherwise fine.
      Accept: 'application/json',
      'Xero-Tenant-Id': tenantId,
    };

    if (modifiedSince) {
      // Xero documents yyyy-mm-ddThh:mm:ss. Its own docs also show an
      // RFC-style example in the same table, and it accepts both; the stated
      // format is the one to send.
      headers['If-Modified-Since'] = modifiedSince.toISOString().slice(0, 19);
    }

    const res = await fetch(`${BASE_URL}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) throw new XeroTokenRevokedError();

    if (res.status === 429) {
      // Number(null) is 0, not NaN, so an absent header has to be ruled out
      // before coercing. A retryAfterSeconds of 0 would read as "retry
      // immediately" where the truth is "Xero did not say".
      const header = res.headers.get('Retry-After');
      const parsed = header === null ? NaN : Number(header);
      const retryAfter = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      const problem = res.headers.get('X-Rate-Limit-Problem');
      const body = await res.text();
      logger.warn({ connectionId, problem, retryAfter }, 'Xero rate limit hit');
      throw new XeroRetryableError(
        `Xero rate limit exceeded (${problem ?? 'unknown limit'})`,
        429,
        body,
        retryAfter,
      );
    }

    if (res.status >= 500) {
      const body = await res.text();
      throw new XeroRetryableError(`Xero server error: ${res.status}`, res.status, body);
    }

    // A conditional GET with nothing modified. Not an error, and not an empty
    // body to parse either.
    if (res.status === 304) return null;

    if (!res.ok) {
      const body = await res.text();
      throw new XeroApiError(`Xero API error: ${res.status}`, res.status, body);
    }

    const remaining = Number(res.headers.get('X-MinLimit-Remaining'));
    if (Number.isFinite(remaining) && remaining <= MIN_LIMIT_WARN_THRESHOLD) {
      logger.warn({ connectionId, remaining }, 'Xero per-minute call allowance running low');
    }

    return res.json();
  }

  return {
    /**
     * One entity type, every page.
     *
     * `page` is not optional despite reading like it. Xero returns a contact
     * summary and **no line items** when several invoices come back at once,
     * and names paging as the way to get them
     * (developer.xero.com/.../invoices). Without it every row would normalize
     * off the transaction total as a single 'Uncategorized' line, which looks
     * like working code and quietly discards the whole chart of accounts.
     */
    async fetchEntity(entity: XeroEntity, modifiedSince?: Date): Promise<XeroTransaction[]> {
      const idField = ID_FIELD[entity];
      const results: XeroTransaction[] = [];
      let page = 1;
      let truncated = false;

      while (true) {
        const payload = (await xeroFetch(`/${entity}?page=${page}`, modifiedSince)) as Record<
          string,
          unknown
        > | null;

        const rows = (payload?.[entity] as Array<Record<string, unknown>> | undefined) ?? [];

        for (const row of rows) {
          const id = row[idField];
          // The reconcile keys on this id and the delete interpolates it, so a
          // row without one cannot be tracked. Same call as the QuickBooks
          // sync: lose the row rather than the batch.
          if (typeof id !== 'string' || id.length === 0) continue;
          results.push({ ...row, id } as XeroTransaction);
        }

        if (rows.length < PAGE_SIZE) break;
        page += 1;
        if (page > MAX_PAGES) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        logger.warn(
          { connectionId, entity, count: results.length },
          'Xero fetch hit the page cap, results are incomplete',
        );
      }
      logger.info({ connectionId, entity, count: results.length }, 'Xero entity fetched');
      return results;
    },

    /**
     * Account code to account name, so a category reads "Electricity" instead
     * of "445". Line items carry only the code, which is the whole reason
     * `accounting.settings.read` is in the scope set.
     *
     * A failure here is not fatal to the caller: an empty map degrades every
     * category to its code, which is worse than useless but still a dataset,
     * where throwing would discard a sync's transactions over a labelling
     * lookup.
     */
    async fetchAccountNames(): Promise<Map<string, string>> {
      const payload = (await xeroFetch('/Accounts')) as {
        Accounts?: Array<{ Code?: string; Name?: string }>;
      } | null;

      const names = new Map<string, string>();
      for (const account of payload?.Accounts ?? []) {
        if (account.Code && account.Name) names.set(account.Code, account.Name);
      }
      return names;
    },

    /**
     * The organisation's own name, for the dataset label.
     *
     * `/connections` also carries a tenantName, but it is documented as
     * nullable and only reflects what the name was when consent was given.
     * This is the live value and is re-read every sync, so an org renamed in
     * Xero gets renamed here too, which is what the QuickBooks connector does
     * with getCompanyInfo. Covered by the same `accounting.settings.read` the
     * accounts lookup already needs, so it costs a call rather than a scope.
     */
    async fetchOrganisationName(): Promise<string | null> {
      const payload = (await xeroFetch('/Organisation')) as {
        Organisations?: Array<{ Name?: string }>;
      } | null;

      const name = payload?.Organisations?.[0]?.Name?.trim();
      return name && name.length > 0 ? name : null;
    },
  };
}
