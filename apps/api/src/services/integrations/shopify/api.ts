import { logger } from '../../../lib/logger.js';
import { decrypt } from '../encryption.js';
import { integrationConnectionsQueries } from '../../../db/queries/index.js';
import { RetryableError, TokenRevokedError, ShopifyApiError, ConnectionNotFoundError } from './errors.js';

const API_VERSION = '2025-01';
const REQUEST_TIMEOUT_MS = 30_000;

interface GraphqlError {
  message: string;
  extensions?: { code?: string };
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: GraphqlError[];
}

interface ShopifyClient {
  query<T>(gql: string, variables?: Record<string, unknown>): Promise<T>;
  getShopInfo(): Promise<{ shopName: string }>;
}

// No ensureFreshToken step here, unlike QuickBooks. A standard Shopify
// offline access token doesn't expire and has no refresh token to rotate,
// see oauth.ts, so the token decrypted at client construction is valid for
// the client's whole lifetime.
export async function createShopifyClient(connectionId: number): Promise<ShopifyClient> {
  const connection = await integrationConnectionsQueries.getByIdAndProvider(connectionId, 'shopify');
  if (!connection) throw new ConnectionNotFoundError(connectionId);

  const shop = connection.providerTenantId;
  const accessToken = decrypt(connection.encryptedAccessToken);
  const endpoint = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  async function shopifyFetch<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query: gql, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) {
      throw new TokenRevokedError();
    }
    if (res.status >= 500) {
      const body = await res.text();
      throw new RetryableError(`Shopify server error: ${res.status}`, res.status, body);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new ShopifyApiError(`Shopify API error: ${res.status}`, res.status, body);
    }

    const payload = (await res.json()) as GraphqlResponse<T>;

    if (payload.errors?.length) {
      const codes = payload.errors.map((e) => e.extensions?.code);
      const messages = payload.errors.map((e) => e.message).join('; ');

      if (codes.includes('THROTTLED') || codes.includes('MAX_COST_EXCEEDED')) {
        throw new RetryableError('Shopify rate limit exceeded', 429, messages);
      }
      if (codes.includes('ACCESS_DENIED')) {
        throw new TokenRevokedError();
      }
      throw new ShopifyApiError(`Shopify GraphQL error: ${messages}`, 200, messages);
    }

    if (!payload.data) {
      throw new ShopifyApiError('Shopify GraphQL response had no data', 200);
    }

    return payload.data;
  }

  return {
    query: shopifyFetch,

    async getShopInfo(): Promise<{ shopName: string }> {
      const data = await shopifyFetch<{ shop: { name: string } }>(
        `query { shop { name } }`,
      );
      return { shopName: data.shop?.name ?? shop };
    },
  };
}

// Cursor-paginates a GraphQL connection field (edges/node/pageInfo shape).
// `extract` pulls the connection object out of the query's response so this
// helper works for orders(...), products(...), etc. without knowing the
// field name in advance.
export async function paginateAll<TNode>(
  client: ShopifyClient,
  gql: string,
  extract: (data: unknown) => { edges: { node: TNode }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
  baseVariables: Record<string, unknown> = {},
): Promise<TNode[]> {
  const results: TNode[] = [];
  let cursor: string | null = null;

  while (true) {
    const data = await client.query<unknown>(gql, { ...baseVariables, after: cursor });
    const connection = extract(data);

    results.push(...connection.edges.map((e) => e.node));

    if (!connection.pageInfo.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
  }

  logger.info({ count: results.length }, 'Shopify pagination complete');
  return results;
}
