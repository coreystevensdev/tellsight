import { env } from '../../../config.js';
import {
  PlaidApiError,
  PlaidCursorInvalidError,
  PlaidItemLoginRequiredError,
  PlaidRetryableError,
} from './errors.js';
import type {
  PlaidErrorBody,
  PlaidItemPublicTokenExchangeResponse,
  PlaidLinkTokenCreateResponse,
  PlaidSyncResponse,
} from './types.js';

const PRODUCTS = ['transactions'];
const COUNTRY_CODES = ['US'];
const LANGUAGE = 'en';

// Plaid pages /transactions/sync, and a reset mid-pagination is reported rather
// than retried, so a bound stops a corrupted cursor spinning forever.
const MAX_SYNC_PAGES = 50;

function baseUrl(): string {
  return env.PLAID_ENVIRONMENT === 'production'
    ? 'https://production.plaid.com'
    : 'https://sandbox.plaid.com';
}

// Plaid authenticates in the body rather than a header, so every call carries
// the credentials and there is no Authorization to set.
function credentials() {
  return { client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET };
}

function classify(status: number, body: PlaidErrorBody, raw: string): PlaidApiError {
  const code = body.error_code;
  const message = body.error_message ?? `Plaid request failed with ${status}`;

  if (code === 'ITEM_LOGIN_REQUIRED') return new PlaidItemLoginRequiredError(message);
  if (
    code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' ||
    code === 'INVALID_FIELD' /* a cursor Plaid no longer recognises */
  ) {
    return new PlaidCursorInvalidError(message);
  }

  // RATE_LIMIT_EXCEEDED and PLANNED_MAINTENANCE both clear on their own, and
  // anything 5xx is Plaid's side. Everything else is a request we got wrong,
  // which retrying cannot fix.
  if (status >= 500 || code === 'RATE_LIMIT_EXCEEDED' || code === 'PLANNED_MAINTENANCE') {
    return new PlaidRetryableError(message, status, code, raw);
  }

  return new PlaidApiError(message, status, code, raw);
}

async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials(), ...payload }),
  });

  if (!res.ok) {
    const raw = await res.text();
    let body: PlaidErrorBody = {};
    try {
      body = JSON.parse(raw) as PlaidErrorBody;
    } catch {
      // Plaid returns JSON for its own errors; a proxy or gateway in front of it
      // may not, and the status still classifies it.
    }
    throw classify(res.status, body, raw);
  }

  return res.json() as Promise<T>;
}

/**
 * Mints the token the browser hands to Plaid Link.
 *
 * Scoped to one org through `client_user_id`, which is what ties the Item Plaid
 * creates back to a tenant. Plaid dedupes by that value, so passing an org id
 * rather than a per-click uuid is what stops one org accumulating an Item per
 * attempt.
 */
export function createLinkToken(orgId: number): Promise<PlaidLinkTokenCreateResponse> {
  return post<PlaidLinkTokenCreateResponse>('/link/token/create', {
    user: { client_user_id: String(orgId) },
    client_name: 'Tellsight',
    products: PRODUCTS,
    country_codes: COUNTRY_CODES,
    language: LANGUAGE,
  });
}

export function exchangePublicToken(
  publicToken: string,
): Promise<PlaidItemPublicTokenExchangeResponse> {
  return post<PlaidItemPublicTokenExchangeResponse>('/item/public_token/exchange', {
    public_token: publicToken,
  });
}

export interface SyncPage {
  added: PlaidSyncResponse['added'];
  modified: PlaidSyncResponse['modified'];
  removedIds: string[];
  cursor: string;
}

/**
 * Walks /transactions/sync to the end and returns everything since `cursor`.
 *
 * Accumulated rather than streamed because the caller writes one database
 * transaction per sync: a partial write followed by a stored cursor would mark
 * transactions as seen that no row exists for, and nothing later would fetch
 * them again.
 *
 * `cursor` absent means from the start of history, which is Plaid's own meaning
 * for an omitted cursor and the reason the column is nullable.
 */
export async function fetchTransactionsSince(
  accessToken: string,
  cursor: string | null,
): Promise<SyncPage> {
  const added: PlaidSyncResponse['added'] = [];
  const modified: PlaidSyncResponse['modified'] = [];
  const removedIds: string[] = [];
  let next = cursor ?? undefined;

  for (let page = 0; page < MAX_SYNC_PAGES; page++) {
    const body: Record<string, unknown> = { access_token: accessToken };
    if (next) body.cursor = next;

    const res = await post<PlaidSyncResponse>('/transactions/sync', body);
    added.push(...res.added);
    modified.push(...res.modified);
    removedIds.push(...res.removed.map((r) => r.transaction_id));
    next = res.next_cursor;

    if (!res.has_more) return { added, modified, removedIds, cursor: res.next_cursor };
  }

  throw new PlaidApiError(
    `Plaid sync still reported has_more after ${MAX_SYNC_PAGES} pages`,
    500,
    'SYNC_PAGE_LIMIT',
  );
}
