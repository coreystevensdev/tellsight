import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RetryableError, TokenRevokedError, ConnectionNotFoundError } from './errors.js';

const mockGetByIdAndProvider = vi.fn();
const mockDecrypt = vi.fn();

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: { getByIdAndProvider: mockGetByIdAndProvider },
}));

vi.mock('../encryption.js', () => ({
  decrypt: mockDecrypt,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: 10,
    provider: 'shopify',
    providerTenantId: 'my-store.myshopify.com',
    encryptedAccessToken: 'enc-access',
    encryptedRefreshToken: 'enc-access',
    accessTokenExpiresAt: new Date('9999-12-31T23:59:59Z'),
    syncStatus: 'idle',
    ...overrides,
  };
}

function graphqlResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('Shopify API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockReturnValue('decrypted-access-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createShopifyClient', () => {
    it('throws a terminal ConnectionNotFoundError if connection not found', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(null);
      const { createShopifyClient } = await import('./api.js');
      await expect(createShopifyClient(999)).rejects.toBeInstanceOf(ConnectionNotFoundError);
    });

    it('does not refresh or re-fetch the token before making a request, unlike QuickBooks', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(graphqlResponse({ data: { shop: { name: 'Test Shop' } } }));

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await client.getShopInfo();

      // one connection lookup at construction, no second lookup for a refresh
      expect(mockGetByIdAndProvider).toHaveBeenCalledOnce();
    });
  });

  describe('query', () => {
    it('posts to the shop-scoped GraphQL endpoint with the access token header', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(graphqlResponse({ data: { shop: { name: 'Test Shop' } } }));

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await client.getShopInfo();

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://my-store.myshopify.com/admin/api/2025-01/graphql.json');
      expect((init as RequestInit).headers).toMatchObject({ 'X-Shopify-Access-Token': 'decrypted-access-token' });
    });

    it('maps a 401 to TokenRevokedError', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve('') });

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await expect(client.getShopInfo()).rejects.toBeInstanceOf(TokenRevokedError);
    });

    it('maps a THROTTLED GraphQL error (200 OK with errors[]) to RetryableError', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(
        graphqlResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      );

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await expect(client.getShopInfo()).rejects.toBeInstanceOf(RetryableError);
    });

    it('maps a MAX_COST_EXCEEDED GraphQL error to RetryableError', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(
        graphqlResponse({ errors: [{ message: 'Cost exceeded', extensions: { code: 'MAX_COST_EXCEEDED' } }] }),
      );

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await expect(client.getShopInfo()).rejects.toBeInstanceOf(RetryableError);
    });

    it('maps an ACCESS_DENIED GraphQL error to TokenRevokedError', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(
        graphqlResponse({ errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }] }),
      );

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      await expect(client.getShopInfo()).rejects.toBeInstanceOf(TokenRevokedError);
    });

    it('falls back to the shop domain when the shop name is missing from the response', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(graphqlResponse({ data: { shop: {} } }));

      const { createShopifyClient } = await import('./api.js');
      const client = await createShopifyClient(1);
      const info = await client.getShopInfo();
      expect(info.shopName).toBe('my-store.myshopify.com');
    });
  });

  describe('paginateAll', () => {
    it('follows pageInfo.hasNextPage/endCursor across multiple pages', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch
        .mockResolvedValueOnce(
          graphqlResponse({
            data: {
              orders: {
                edges: [{ node: { id: '1' } }],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          graphqlResponse({
            data: {
              orders: {
                edges: [{ node: { id: '2' } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        );

      const { createShopifyClient, paginateAll } = await import('./api.js');
      const client = await createShopifyClient(1);
      const results = await paginateAll(
        client,
        'query { orders { edges { node { id } } pageInfo { hasNextPage endCursor } } }',
        (data) => (data as { orders: { edges: { node: unknown }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }).orders,
      );

      expect(results).toEqual([{ id: '1' }, { id: '2' }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('stops after one page when hasNextPage is false', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(
        graphqlResponse({
          data: { orders: { edges: [{ node: { id: '1' } }], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      );

      const { createShopifyClient, paginateAll } = await import('./api.js');
      const client = await createShopifyClient(1);
      const results = await paginateAll(
        client,
        'query { orders { edges { node { id } } pageInfo { hasNextPage endCursor } } }',
        (data) => (data as { orders: { edges: { node: unknown }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }).orders,
      );

      expect(results).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledOnce();
    });
  });
});
