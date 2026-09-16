import { randomBytes } from 'node:crypto';

import { env } from '../../../config.js';
import { logger } from '../../../lib/logger.js';
import { dbAdmin } from '../../../lib/db.js';
import { ExternalServiceError } from '../../../lib/appError.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { encrypt, decrypt } from '../encryption.js';

// Read-only, same posture as the other connectors: nothing here writes back to
// the seller's account. MERCHANT_PROFILE_READ is not about the profile, it is
// what ListLocations needs: a Square token is seller-scoped and carries no
// location id, but SearchOrders wants them explicitly.
const SQUARE_SCOPES = ['ORDERS_READ', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ'];

// Square pins behaviour to a dated header rather than a URL segment, so
// omitting it silently gets whatever default the application is pinned to.
const SQUARE_VERSION = '2026-08-19';
const TOKEN_TIMEOUT_MS = 10_000;

// Stands in for "no expiry" the way the Shopify connection rows already do,
// since the column is NOT NULL.
const NO_EXPIRY = new Date('9999-12-31T23:59:59Z');

interface AuthUrlResult {
  authUrl: string;
  state: string;
}

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  merchantId: string;
  expiresAt: Date;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  merchant_id?: string;
  expires_at?: string;
}

export function apiHost(): string {
  return env.SQUARE_ENVIRONMENT === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

export function squareScopes(): string {
  return SQUARE_SCOPES.join(' ');
}

export function generateAuthUrl(): AuthUrlResult {
  const state = randomBytes(24).toString('hex');

  const params = new URLSearchParams({
    client_id: env.SQUARE_CLIENT_ID!,
    scope: squareScopes(),
    // Square requires this to be false for production applications.
    session: 'false',
    state,
    redirect_uri: env.SQUARE_REDIRECT_URI!,
  });

  return { authUrl: `${apiHost()}/oauth2/authorize?${params.toString()}`, state };
}

// Intuit hands back a lifetime in seconds; Square hands back an absolute
// timestamp. Getting that wrong produces a connection that looks valid and
// stops working on day 31, so an unparseable value fails here rather than
// quietly becoming a date far enough away that nothing ever refreshes.
function parseExpiry(raw: string | undefined): Date {
  if (!raw) return NO_EXPIRY;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new ExternalServiceError('Square OAuth', { reason: 'unparseable expires_at' });
  }
  return at;
}

function readTokens(data: TokenResponse): TokenSet {
  if (!data.access_token || !data.refresh_token || !data.merchant_id) {
    throw new ExternalServiceError('Square OAuth', { reason: 'incomplete token response' });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    merchantId: data.merchant_id,
    expiresAt: parseExpiry(data.expires_at),
    scope: squareScopes(),
  };
}

async function postToken(body: Record<string, unknown>, label: string): Promise<TokenSet> {
  const res = await fetch(`${apiHost()}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Square-Version': SQUARE_VERSION },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text();
    logger.error({ status: res.status, detail }, `Square ${label} failed`);
    throw new ExternalServiceError('Square OAuth', { status: res.status });
  }

  return readTokens((await res.json()) as TokenResponse);
}

// The authorization code is only valid for five minutes, so this runs inline
// on the callback rather than being handed to a queue.
export function exchangeCode(code: string): Promise<TokenSet> {
  return postToken(
    {
      client_id: env.SQUARE_CLIENT_ID,
      client_secret: env.SQUARE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: env.SQUARE_REDIRECT_URI,
    },
    'token exchange',
  );
}

// Square refresh tokens do not expire, but access tokens die after 30 days.
// An org that stops syncing for a month therefore has a dead access token and
// a perfectly good refresh token, which is why this is required rather than an
// optimisation. Shopify has no equivalent path.
export function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return postToken(
    {
      client_id: env.SQUARE_CLIENT_ID,
      client_secret: env.SQUARE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    'token refresh',
  );
}

// Best effort, matching the other connectors: the local row is deleted either
// way. The header is `Client <secret>`, not `Bearer` — revoking authenticates
// as the application rather than as the seller.
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    await fetch(`${apiHost()}/oauth2/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Square-Version': SQUARE_VERSION,
        Authorization: `Client ${env.SQUARE_CLIENT_SECRET}`,
      },
      body: JSON.stringify({
        client_id: env.SQUARE_CLIENT_ID,
        access_token: accessToken,
        revoke_only_access_token: false,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, 'Square token revocation failed, best effort');
  }
}

/**
 * Refreshes a stored connection in place and returns the new material.
 *
 * Square rotates the refresh token on every exchange, so writing both tokens
 * back is not optional: keeping the old one would work until the next refresh
 * and then strand the connection.
 */
export async function refreshAccessToken(connectionId: number): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  accessTokenExpiresAt: Date;
}> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(
    connectionId,
    'square',
    dbAdmin,
  );
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  let tokens;
  try {
    tokens = await refreshTokens(decrypt(connection.encryptedRefreshToken));
  } catch (err) {
    // A refresh token Square no longer honours means the seller revoked the
    // application. Nothing retries out of that, so the row is marked rather
    // than left looking healthy.
    await integrationConnectionsQueries.updateSyncStatus(
      connection.id,
      'error',
      'Square access was revoked, please reconnect',
      dbAdmin,
    );
    throw err;
  }

  const encryptedAccessToken = encrypt(tokens.accessToken);
  const encryptedRefreshToken = encrypt(tokens.refreshToken);

  await integrationConnectionsQueries.updateTokens(
    connection.id,
    encryptedAccessToken,
    encryptedRefreshToken,
    tokens.expiresAt,
    dbAdmin,
  );

  logger.info({ connectionId }, 'Refreshed Square access token');
  return { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt: tokens.expiresAt };
}
