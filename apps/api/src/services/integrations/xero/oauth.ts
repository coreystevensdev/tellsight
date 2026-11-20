import { randomBytes } from 'node:crypto';

import { env } from '../../../config.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { ExternalServiceError } from '../../../lib/appError.js';
import { dbAdmin } from '../../../lib/db.js';
import { logger } from '../../../lib/logger.js';
import { decrypt, encrypt } from '../encryption.js';
import { adoptRotatedTokens, commitRotatedTokens, requireRefreshToken } from '../tokenRotation.js';
import { XeroNoTenantError } from './errors.js';
import type { XeroTenant } from './types.js';

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_REVOKE_URL = 'https://identity.xero.com/connect/revocation';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

/**
 * Granular scopes, one per endpoint family this connector actually reads.
 *
 * `accounting.transactions.read` was the original and is **deprecated**. Xero
 * assigned granular scopes to every Web and PKCE app in March 2026, and an app
 * created after that date does not have the broad one at all: requesting it
 * fails the authorize call outright with `invalid_scope`, before the consent
 * screen. Nothing in this repo could have predicted that, and nothing in it can
 * detect the next such change either; the live probe is what found it.
 *
 * The migration turned out to be a privacy improvement rather than a rename.
 * The broad scope granted Payments, ManualJournals, Quotes, PurchaseOrders,
 * Receipts, ExpenseClaims and Overpayments along with what we wanted. These
 * three grant only what `sync.ts` fetches:
 *
 *   - `accounting.invoices.read`         Invoices and CreditNotes
 *   - `accounting.banktransactions.read` BankTransactions
 *   - `accounting.settings.read`         Accounts and Organisation
 *
 * `accounting.payments.read` and `accounting.manualjournals.read` are the other
 * two halves of the old broad scope and are deliberately absent: the connector
 * does not fetch Payments (a Xero payment settles an invoice `Invoices` already
 * reported, so reading them would double-count) and does not fetch
 * ManualJournals at all.
 *
 * `accounting.contacts.read` stays out for the reason it always did. The
 * product wants one field from a contact, the name, and that arrives embedded
 * in every invoice and bank transaction already. The contacts scope would add
 * the `/Contacts` endpoint: emails, phone numbers, postal addresses and bank
 * details, none of which this product has a use for.
 *
 * `offline_access` is what makes a refresh token exist. Note it cannot be
 * requested on its own: it grants access to nothing by itself and Xero rejects
 * a request carrying only it, which reads as the scope being unavailable when
 * it is simply incomplete.
 */
const XERO_SCOPE =
  'offline_access accounting.invoices.read accounting.banktransactions.read accounting.settings.read';

const TOKEN_TIMEOUT_MS = 10_000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

interface AuthUrlResult {
  authUrl: string;
  state: string;
}

interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

function basicAuth(): string {
  return Buffer.from(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`).toString('base64');
}

export function generateAuthUrl(): AuthUrlResult {
  const state = randomBytes(24).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.XERO_CLIENT_ID!,
    redirect_uri: env.XERO_REDIRECT_URI!,
    state,
  });

  // scope is appended by hand because `URLSearchParams` encodes a space as `+`,
  // the form-urlencoded convention, and Xero percent-decodes this query string
  // per RFC 3986 where `+` is a literal plus. Three scopes joined by spaces
  // therefore arrive as one nonsense token and Xero answers invalid_scope.
  //
  // Square builds its URL the same way and survives it, which is why nothing
  // caught this earlier: its server form-decodes and reads the `+` as a space.
  // QuickBooks and Shopify never had the problem at all, one scope and a
  // comma-separated list respectively, so neither carries a space to mangle.
  //
  // Only the query string is affected. The token exchanges below pass
  // `URLSearchParams` as a request *body* under
  // application/x-www-form-urlencoded, where `+` for a space is correct.
  const authUrl = `${XERO_AUTH_URL}?${params.toString()}&scope=${encodeURIComponent(XERO_SCOPE)}`;

  return { authUrl, state };
}

export async function exchangeCode(code: string): Promise<TokenExchangeResult> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.XERO_REDIRECT_URI!,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero token exchange failed');
    throw new ExternalServiceError('Xero OAuth', { status: res.status });
  }

  const data = (await res.json()) as TokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope ?? XERO_SCOPE,
  };
}

/**
 * The tenants this access token may act on.
 *
 * Filtered to `ORGANISATION`. A Xero login can also authorize `PRACTICE` and
 * `PRACTICEMANAGER` tenants, which are an accounting firm's own workspace
 * rather than a business ledger, and syncing one would produce a dataset with
 * no transactions and a null name. `tenantName` is documented as nullable even
 * for an organisation, so the dataset name falls back to the id rather than
 * trusting it.
 */
export async function fetchTenants(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Xero connections lookup failed');
    throw new ExternalServiceError('Xero connections', { status: res.status });
  }

  const data = (await res.json()) as Array<{
    tenantId?: string;
    tenantName?: string | null;
    tenantType?: string;
  }>;

  const tenants = (Array.isArray(data) ? data : [])
    .filter((row) => row.tenantType === 'ORGANISATION' && typeof row.tenantId === 'string')
    .map((row) => ({
      tenantId: row.tenantId!,
      tenantName: row.tenantName ?? null,
      tenantType: row.tenantType!,
    }));

  if (tenants.length === 0) throw new XeroNoTenantError();
  return tenants;
}

/**
 * Xero invalidates the previous refresh token the moment a new pair is issued,
 * which its own guidance calls out alongside "avoid race conditions during
 * rotation" (developer.xero.com/.../managing-tokens).
 *
 * That makes the shared compare-and-set in tokenRotation.ts load-bearing here
 * rather than defensive. For QuickBooks a lost race is survivable, because
 * Intuit honours the old token for a grace period. For Xero the loser would
 * write a token the provider has already destroyed, and the connection stays
 * bricked until the owner reconnects.
 */
export async function refreshAccessToken(connectionId: number): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  accessTokenExpiresAt: Date;
}> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'xero',
    dbAdmin,
  );
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const startedFrom = requireRefreshToken(connection);
  const refreshToken = decrypt(startedFrom);

  const res = await fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, connectionId }, 'Xero token refresh failed');

    // 400 as well as 401: Xero answers an already-spent refresh token with
    // invalid_grant at 400, where Intuit uses 401. Both are indistinguishable
    // from a real revocation at the HTTP layer, and only the stored token tells
    // them apart.
    if (res.status === 401 || res.status === 400) {
      const adopted = await adoptRotatedTokens(connectionId, 'xero', startedFrom);
      if (adopted) return adopted;

      await integrationConnectionsQueries.updateSyncStatus(
        connection.id,
        'error',
        'Xero access was revoked, please reconnect',
        dbAdmin,
      );
      throw new ExternalServiceError('Xero OAuth, token revoked', { status: res.status });
    }

    throw new ExternalServiceError('Xero OAuth', { status: res.status });
  }

  const data = (await res.json()) as TokenResponse;

  return commitRotatedTokens(connectionId, 'xero', startedFrom, {
    encryptedAccessToken: encrypt(data.access_token),
    encryptedRefreshToken: encrypt(data.refresh_token),
    accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
  });
}

export async function revokeToken(encryptedRefreshToken: string): Promise<void> {
  try {
    const refreshToken = decrypt(encryptedRefreshToken);

    // Revoking the refresh token removes every connection this token granted,
    // which is what disconnect means here.
    await fetch(XERO_REVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth()}`,
        Accept: 'application/json',
      },
      body: new URLSearchParams({ token: refreshToken }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, 'Xero token revocation failed, best effort');
  }
}
