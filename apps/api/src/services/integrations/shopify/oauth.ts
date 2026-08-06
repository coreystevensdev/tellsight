import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../../config.js';
import { logger } from '../../../lib/logger.js';
import { ExternalServiceError } from '../../../lib/appError.js';

// read-only across the whole app posture: this connector only ever reads,
// never writes back to the merchant's store.
const SHOPIFY_SCOPES = 'read_orders,read_products,read_inventory';
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const TOKEN_TIMEOUT_MS = 10_000;

interface AuthUrlResult {
  authUrl: string;
  state: string;
}

interface TokenExchangeResult {
  accessToken: string;
  shop: string;
}

interface TokenResponse {
  access_token: string;
  scope: string;
}

export function isValidShopDomain(shop: string): boolean {
  return SHOP_DOMAIN_RE.test(shop);
}

export function generateAuthUrl(shop: string): AuthUrlResult {
  if (!isValidShopDomain(shop)) {
    throw new ExternalServiceError('Shopify OAuth', { reason: 'invalid shop domain' });
  }

  const state = randomBytes(24).toString('hex');

  const params = new URLSearchParams({
    client_id: env.SHOPIFY_CLIENT_ID!,
    scope: SHOPIFY_SCOPES,
    redirect_uri: env.SHOPIFY_REDIRECT_URI!,
    state,
  });

  return { authUrl: `https://${shop}/admin/oauth/authorize?${params.toString()}`, state };
}

// Shopify signs every callback query string (minus hmac/signature) with the
// app's client secret. Verifying this is what proves the redirect actually
// came from Shopify and the shop param wasn't forged, this runs before the
// state-cookie check, not instead of it, they're independent protections
// (HMAC proves authenticity, state proves it's this browser's own flow).
export function verifyHmac(query: Record<string, string | undefined>): boolean {
  const { hmac } = query;
  if (!hmac) return false;

  const message = Object.keys(query)
    .filter((key) => key !== 'hmac' && key !== 'signature' && query[key] !== undefined)
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join('&');

  const computed = createHmac('sha256', env.SHOPIFY_CLIENT_SECRET!).update(message).digest('hex');

  const a = Buffer.from(hmac);
  const b = Buffer.from(computed);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function exchangeCode(shop: string, code: string): Promise<TokenExchangeResult> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, 'Shopify token exchange failed');
    throw new ExternalServiceError('Shopify OAuth', { status: res.status });
  }

  const data = (await res.json()) as TokenResponse;

  return { accessToken: data.access_token, shop };
}

// Best effort, matches the QuickBooks disconnect posture: the token still
// gets deleted locally either way, this just tells Shopify to invalidate it
// too. appRevokeAccessScopes is the closest GraphQL equivalent to a classic
// OAuth revoke endpoint (Shopify's classic apps have no dedicated one).
export async function revokeToken(shop: string, accessToken: string): Promise<void> {
  try {
    await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({
        query: `mutation revoke($scopes: [String!]!) { appRevokeAccessScopes(scopes: $scopes) { revoked { handle } userErrors { message } } }`,
        variables: { scopes: SHOPIFY_SCOPES.split(',') },
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, 'Shopify token revocation failed, best effort');
  }
}
