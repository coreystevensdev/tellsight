import { randomBytes } from 'node:crypto';

import { env } from '../../../config.js';
import { logger } from '../../../lib/logger.js';
import { ExternalServiceError } from '../../../lib/appError.js';
import { encrypt, decrypt } from '../encryption.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';

const INTUIT_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const INTUIT_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const QB_SCOPE = 'com.intuit.quickbooks.accounting';
const TOKEN_TIMEOUT_MS = 10_000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  x_refresh_token_expires_in: number;
}

interface AuthUrlResult {
  authUrl: string;
  state: string;
}

interface TokenExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  realmId: string;
}

export function generateAuthUrl(): AuthUrlResult {
  const state = randomBytes(24).toString('hex');

  const params = new URLSearchParams({
    client_id: env.QUICKBOOKS_CLIENT_ID!,
    redirect_uri: env.QUICKBOOKS_REDIRECT_URI!,
    response_type: 'code',
    scope: QB_SCOPE,
    state,
  });

  return { authUrl: `${INTUIT_AUTH_URL}?${params.toString()}`, state };
}

export async function exchangeCode(code: string, realmId: string): Promise<TokenExchangeResult> {
  const credentials = Buffer.from(
    `${env.QUICKBOOKS_CLIENT_ID}:${env.QUICKBOOKS_CLIENT_SECRET}`,
  ).toString('base64');

  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.QUICKBOOKS_REDIRECT_URI!,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Intuit token exchange failed');
    throw new ExternalServiceError('Intuit OAuth', { status: res.status });
  }

  const data = (await res.json()) as TokenResponse;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    realmId,
  };
}

export async function refreshAccessToken(connectionId: number): Promise<{
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  accessTokenExpiresAt: Date;
}> {
  const connection = await integrationConnectionsQueries.getByOrgAndProvider(connectionId, 'quickbooks');
  if (!connection) throw new Error(`Connection ${connectionId} not found`);

  const refreshToken = decrypt(connection.encryptedRefreshToken);
  const credentials = Buffer.from(
    `${env.QUICKBOOKS_CLIENT_ID}:${env.QUICKBOOKS_CLIENT_SECRET}`,
  ).toString('base64');

  const res = await fetch(INTUIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
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
    logger.error({ status: res.status, body, connectionId }, 'Intuit token refresh failed');

    if (res.status === 401) {
      await integrationConnectionsQueries.updateSyncStatus(
        connection.id,
        'error',
        'QuickBooks access was revoked, please reconnect',
      );
      throw new ExternalServiceError('Intuit OAuth, token revoked', { status: 401 });
    }

    throw new ExternalServiceError('Intuit OAuth', { status: res.status });
  }

  const data = (await res.json()) as TokenResponse;

  const encryptedAccessToken = encrypt(data.access_token);
  const encryptedRefreshToken = encrypt(data.refresh_token);
  const accessTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000);

  await integrationConnectionsQueries.updateTokens(
    connection.id,
    encryptedAccessToken,
    encryptedRefreshToken,
    accessTokenExpiresAt,
  );

  return { encryptedAccessToken, encryptedRefreshToken, accessTokenExpiresAt };
}

export async function revokeToken(encryptedRefreshToken: string): Promise<void> {
  try {
    const refreshToken = decrypt(encryptedRefreshToken);
    const credentials = Buffer.from(
      `${env.QUICKBOOKS_CLIENT_ID}:${env.QUICKBOOKS_CLIENT_SECRET}`,
    ).toString('base64');

    await fetch(INTUIT_REVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: refreshToken }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, 'Intuit token revocation failed, best effort');
  }
}
