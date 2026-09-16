import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RetryableError, TokenRevokedError, ConnectionNotFoundError } from './errors.js';

const mockGetByIdAndProvider = vi.fn();
const mockRefreshAccessToken = vi.fn();
const mockDecrypt = vi.fn();

vi.mock('../../../config.js', () => ({
  env: { QUICKBOOKS_ENVIRONMENT: 'sandbox' },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
  },
}));

vi.mock('../encryption.js', () => ({
  decrypt: mockDecrypt,
}));

vi.mock('./oauth.js', () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    orgId: 10,
    provider: 'quickbooks',
    providerTenantId: 'realm123',
    encryptedAccessToken: 'enc-access',
    encryptedRefreshToken: 'enc-refresh',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
    syncStatus: 'idle',
    ...overrides,
  };
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('QB API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecrypt.mockReturnValue('decrypted-access-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createQbClient', () => {
    it('throws a terminal ConnectionNotFoundError if connection not found', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(null);

      const { createQbClient } = await import('./api.js');
      await expect(createQbClient(999)).rejects.toBeInstanceOf(ConnectionNotFoundError);
      mockGetByIdAndProvider.mockResolvedValueOnce(null);
      await expect(createQbClient(999)).rejects.toThrow('Connection 999 not found');
    });
  });

  describe('query', () => {
    it('fetches single page of transactions', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      const purchases = Array.from({ length: 5 }, (_, i) => ({ Id: String(i + 1) }));
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ QueryResponse: { Purchase: purchases } }),
      );

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      const result = await client.query('Purchase');

      expect(result).toHaveLength(5);
      expect(mockFetch).toHaveBeenCalledOnce();
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('sandbox-quickbooks.api.intuit.com');
      expect(url).toContain('STARTPOSITION%201');
      expect(url).toContain('MAXRESULTS%201000');
    });

    it('paginates when results fill a page', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      const fullPage = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i + 1) }));
      const partialPage = Array.from({ length: 42 }, (_, i) => ({ Id: String(1001 + i) }));

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Invoice: fullPage } }))
        .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Invoice: partialPage } }));

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      const result = await client.query('Invoice');

      expect(result).toHaveLength(1042);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const secondUrl = mockFetch.mock.calls[1]![0] as string;
      expect(secondUrl).toContain('STARTPOSITION%201001');
    });

    it('appends WHERE clause for incremental sync', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(jsonResponse({ QueryResponse: { Bill: [] } }));

      const since = new Date('2026-04-10T03:00:00Z');
      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      await client.query('Bill', since);

      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain(encodeURIComponent("MetaData.LastUpdatedTime > '2026-04-10T03:00:00.000Z'"));
    });

    it('returns empty array when no results', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(jsonResponse({ QueryResponse: {} }));

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      const result = await client.query('Deposit');

      expect(result).toEqual([]);
    });
  });

  describe('token refresh', () => {
    it('refreshes token when near expiry', async () => {
      const nearExpiry = new Date(Date.now() + 2 * 60 * 1000); // 2 min from now (< 5 min buffer)
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection({ accessTokenExpiresAt: nearExpiry }));
      mockRefreshAccessToken.mockResolvedValueOnce({
        encryptedAccessToken: 'new-enc-access',
        encryptedRefreshToken: 'new-enc-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      mockDecrypt.mockReturnValueOnce('old-access'); // initial decrypt
      mockDecrypt.mockReturnValueOnce('fresh-access'); // post-refresh decrypt
      mockFetch.mockResolvedValueOnce(jsonResponse({ QueryResponse: {} }));

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      await client.query('Payment');

      expect(mockRefreshAccessToken).toHaveBeenCalledWith(1);
      const authHeader = mockFetch.mock.calls[0]![1]?.headers?.Authorization;
      expect(authHeader).toBe('Bearer fresh-access');
    });

    it('skips refresh when token is still valid', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(jsonResponse({ QueryResponse: {} }));

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      await client.query('Transfer');

      expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws RetryableError on 429', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      });

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);

      await expect(client.query('Purchase')).rejects.toThrow(RetryableError);
    });

    it('throws RetryableError on 5xx', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service unavailable'),
      });

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);

      await expect(client.query('Invoice')).rejects.toThrow(RetryableError);
    });

    it('throws TokenRevokedError on 401', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      });

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);

      await expect(client.query('SalesReceipt')).rejects.toThrow(TokenRevokedError);
    });
  });

  describe('getCompanyInfo', () => {
    it('returns company name', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ CompanyInfo: { CompanyName: 'Sunrise Cafe' } }),
      );

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      const info = await client.getCompanyInfo();

      expect(info.companyName).toBe('Sunrise Cafe');
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toContain('/companyinfo/realm123');
    });

    it('falls back to default name when missing', async () => {
      mockGetByIdAndProvider.mockResolvedValueOnce(mockConnection());
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      const { createQbClient } = await import('./api.js');
      const client = await createQbClient(1);
      const info = await client.getCompanyInfo();

      expect(info.companyName).toBe('QuickBooks Company');
    });
  });
});
