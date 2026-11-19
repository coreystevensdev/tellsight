import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetByIdAndProvider = vi.fn();
const mockRefreshAccessToken = vi.fn();

vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: { getByIdAndProvider: mockGetByIdAndProvider },
}));
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../encryption.js', () => ({ decrypt: (v: string) => `plain:${v}` }));
vi.mock('./oauth.js', () => ({ refreshAccessToken: mockRefreshAccessToken }));

const { createXeroClient, MAX_PAGES } = await import('./api.js');
const { XeroApiError, XeroRetryableError, XeroTokenRevokedError } = await import('./errors.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// An hour out, so nothing triggers the refresh buffer unless a test wants it.
const FRESH = () => new Date(Date.now() + 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByIdAndProvider.mockResolvedValue({
    id: 5,
    orgId: 2,
    providerTenantId: 'tenant-abc',
    encryptedAccessToken: 'enc-access',
    accessTokenExpiresAt: FRESH(),
  });
});

function lastRequest() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: url as string, headers: (init as RequestInit).headers as Record<string, string> };
}

describe('request shape', () => {
  /**
   * The one that would have shipped a silently broken connector.
   *
   * Xero returns a contact summary and **no line items** when several invoices
   * come back at once, and names paging as the way to get them. Without `page`
   * every row would normalize off the transaction total as one
   * 'Uncategorized' line: working code, no chart of accounts.
   */
  it('asks for a page, which is what makes Xero return line items at all', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(lastRequest().url).toContain('page=1');
  });

  // Xero serves XML by default, so omitting this makes res.json() throw on a
  // response that was otherwise fine.
  it('asks for JSON explicitly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(lastRequest().headers.Accept).toBe('application/json');
  });

  it('sends the tenant id, which is what scopes the call to one organisation', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(lastRequest().headers['Xero-Tenant-Id']).toBe('tenant-abc');
  });

  it('sends the access token it decrypted', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(lastRequest().headers.Authorization).toBe('Bearer plain:enc-access');
  });
});

describe('incremental fetches', () => {
  it('sends If-Modified-Since in the format Xero documents', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices', new Date('2026-03-04T05:06:07.890Z'));

    expect(lastRequest().headers['If-Modified-Since']).toBe('2026-03-04T05:06:07');
  });

  // A backfill exists precisely to fetch without this header, because
  // If-Modified-Since is modification-based and a settled ledger reports
  // nothing changed (DW-292).
  it('omits the header entirely when no date is given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(lastRequest().headers['If-Modified-Since']).toBeUndefined();
  });

  // A conditional GET with nothing modified. Not an error, and not a body to
  // parse either.
  it('treats a 304 as no rows rather than as a failure', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 304,
      headers: new Headers(),
      json: async () => {
        throw new Error('no body');
      },
      text: async () => '',
    });
    const client = await createXeroClient(5);

    await expect(client.fetchEntity('Invoices', new Date())).resolves.toEqual([]);
  });
});

describe('pagination', () => {
  function page(count: number, startAt = 0) {
    return jsonResponse({
      Invoices: Array.from({ length: count }, (_, i) => ({ InvoiceID: `inv-${startAt + i}` })),
    });
  }

  it('stops on a short page', async () => {
    fetchMock.mockResolvedValueOnce(page(99));
    const client = await createXeroClient(5);

    const rows = await client.fetchEntity('Invoices');

    expect(rows).toHaveLength(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps going while pages come back full', async () => {
    fetchMock.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(7, 100));
    const client = await createXeroClient(5);

    const rows = await client.fetchEntity('Invoices');

    expect(rows).toHaveLength(107);
    expect(fetchMock.mock.calls[1]![0]).toContain('page=2');
  });

  // An endpoint that always answers with a full page would otherwise never
  // terminate.
  it('gives up at the page cap rather than looping forever', async () => {
    fetchMock.mockResolvedValue(page(100));
    const client = await createXeroClient(5);

    const rows = await client.fetchEntity('Invoices');

    expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
    expect(rows).toHaveLength(MAX_PAGES * 100);
  });

  // The reconcile keys on this id and the delete interpolates it, so a row
  // without one cannot be tracked. Lose the row rather than the batch.
  it('skips a row with no id of its own', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Invoices: [{ InvoiceID: 'a' }, {}, { InvoiceID: '' }, { InvoiceID: 'b' }] }),
    );
    const client = await createXeroClient(5);

    const rows = await client.fetchEntity('Invoices');

    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('reads each entity id out of its own field', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ BankTransactions: [{ BankTransactionID: 'bt-1' }] }),
    );
    const client = await createXeroClient(5);

    expect((await client.fetchEntity('BankTransactions')).map((r) => r.id)).toEqual(['bt-1']);
  });
});

describe('failures', () => {
  it('reports a revoked token as its own terminal error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = await createXeroClient(5);

    await expect(client.fetchEntity('Invoices')).rejects.toBeInstanceOf(XeroTokenRevokedError);
  });

  // Xero's minute limit and its daily limit need very different responses, and
  // Retry-After is the only thing that distinguishes a short wait from a dead
  // day, so it has to survive onto the error.
  it('carries Retry-After off a 429 so the wait is diagnosable', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({}, { status: 429, headers: { 'Retry-After': '24', 'X-Rate-Limit-Problem': 'minute' } }),
    );
    const client = await createXeroClient(5);

    await expect(client.fetchEntity('Invoices')).rejects.toMatchObject({
      name: 'XeroRetryableError',
      retryAfterSeconds: 24,
      statusCode: 429,
    });
  });

  it('survives a 429 with no Retry-After rather than carrying NaN', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 429 }));
    const client = await createXeroClient(5);

    await expect(client.fetchEntity('Invoices')).rejects.toMatchObject({
      retryAfterSeconds: undefined,
    });
  });

  it('marks a server error retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
    const client = await createXeroClient(5);

    await expect(client.fetchEntity('Invoices')).rejects.toBeInstanceOf(XeroRetryableError);
  });

  // A 400 is the app's own fault and will fail identically on every retry.
  it('does not mark a client error retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 400 }));
    const client = await createXeroClient(5);

    const err = await client.fetchEntity('Invoices').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(XeroApiError);
    expect(err).not.toBeInstanceOf(XeroRetryableError);
  });

  it('refuses to build a client for a connection that is gone', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(undefined);

    await expect(createXeroClient(5)).rejects.toMatchObject({
      name: 'XeroConnectionNotFoundError',
    });
  });
});

describe('token refresh', () => {
  it('refreshes before a call when the token is inside the buffer', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce({
      id: 5,
      orgId: 2,
      providerTenantId: 'tenant-abc',
      encryptedAccessToken: 'enc-old',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000),
    });
    mockRefreshAccessToken.mockResolvedValue({
      encryptedAccessToken: 'enc-new',
      accessTokenExpiresAt: FRESH(),
    });
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));

    const client = await createXeroClient(5);
    await client.fetchEntity('Invoices');

    expect(mockRefreshAccessToken).toHaveBeenCalledWith(5);
    expect(lastRequest().headers.Authorization).toBe('Bearer plain:enc-new');
  });

  // One refresh per client, not one per page. Xero destroys the previous
  // refresh token on rotation, so a second concurrent refresh is the race
  // tokenRotation.ts exists to settle (DW-283) and is worth not provoking.
  it('refreshes once across a paginated fetch', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce({
      id: 5,
      orgId: 2,
      providerTenantId: 'tenant-abc',
      encryptedAccessToken: 'enc-old',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000),
    });
    mockRefreshAccessToken.mockResolvedValue({
      encryptedAccessToken: 'enc-new',
      accessTokenExpiresAt: FRESH(),
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ Invoices: Array.from({ length: 100 }, (_, i) => ({ InvoiceID: `i${i}` })) }),
      )
      .mockResolvedValueOnce(jsonResponse({ Invoices: [] }));

    const client = await createXeroClient(5);
    await client.fetchEntity('Invoices');

    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a token that is still good', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Invoices: [] }));
    const client = await createXeroClient(5);

    await client.fetchEntity('Invoices');

    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});

describe('lookups', () => {
  it('maps account codes to their names', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        Accounts: [
          { Code: '200', Name: 'Sales' },
          { Code: '445', Name: 'Electricity' },
          { Name: 'No code' },
        ],
      }),
    );
    const client = await createXeroClient(5);

    const names = await client.fetchAccountNames();

    expect([...names.entries()]).toEqual([
      ['200', 'Sales'],
      ['445', 'Electricity'],
    ]);
  });

  it('returns an empty map rather than throwing when Xero sends no accounts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const client = await createXeroClient(5);

    expect((await client.fetchAccountNames()).size).toBe(0);
  });

  it('reads the organisation name for the dataset label', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Organisations: [{ Name: 'Maple Florist' }] }));
    const client = await createXeroClient(5);

    expect(await client.fetchOrganisationName()).toBe('Maple Florist');
  });

  it('reports no organisation name rather than a blank one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ Organisations: [{ Name: '  ' }] }));
    const client = await createXeroClient(5);

    expect(await client.fetchOrganisationName()).toBeNull();
  });
});
