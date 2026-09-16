import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const connection = {
  id: 7,
  orgId: 1,
  provider: 'square',
  providerTenantId: 'MERCHANT1',
  encryptedAccessToken: 'enc-access',
  encryptedRefreshToken: 'enc-refresh',
  accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
};

const getByIdAndProvider = vi.fn();
const refreshAccessToken = vi.fn();

vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: (...a: unknown[]) => getByIdAndProvider(...a),
  },
}));
vi.mock('../encryption.js', () => ({
  decrypt: (v: string) => `dec(${v})`,
  encrypt: (v: string) => `enc(${v})`,
}));
vi.mock('./oauth.js', () => ({
  apiHost: () => 'https://connect.squareupsandbox.com',
  refreshAccessToken: (...a: unknown[]) => refreshAccessToken(...a),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createSquareClient } = await import('./api.js');
const { TokenRevokedError, RetryableError, ConnectionNotFoundError, SquareApiError } =
  await import('./errors.js');

function respond(bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => '',
    });
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  getByIdAndProvider.mockResolvedValue({ ...connection });
  refreshAccessToken.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('createSquareClient', () => {
  it('refuses to build a client for a connection that is gone', async () => {
    getByIdAndProvider.mockResolvedValue(null);
    await expect(createSquareClient(7)).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });
});

describe('listLocations', () => {
  it('drops inactive locations, which cannot produce orders', async () => {
    respond([
      {
        locations: [{ id: 'L1', status: 'ACTIVE' }, { id: 'L2', status: 'INACTIVE' }, { id: 'L3' }],
      },
    ]);
    const client = await createSquareClient(7);
    expect((await client.listLocations()).map((l) => l.id)).toEqual(['L1', 'L3']);
  });

  it('sends the pinned Square-Version, not whatever the app defaults to', async () => {
    const fetchMock = respond([{ locations: [] }]);
    await (await createSquareClient(7)).listLocations();
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers['Square-Version']).toBe('2026-08-19');
    expect(headers.Authorization).toBe('Bearer dec(enc-access)');
  });
});

describe('searchOrders', () => {
  // SearchOrders rejects an empty location list, and a seller with no active
  // locations is a real state rather than an error.
  it('does not call the API at all with no locations', async () => {
    const fetchMock = respond([]);
    expect(await (await createSquareClient(7)).searchOrders([], new Date())).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows the cursor until it stops coming back', async () => {
    const fetchMock = respond([
      { orders: [{ id: 'o1' }], cursor: 'c1' },
      { orders: [{ id: 'o2' }], cursor: 'c2' },
      { orders: [{ id: 'o3' }] },
    ]);
    const orders = await (await createSquareClient(7)).searchOrders(['L1'], new Date('2026-01-01'));

    expect(orders.map((o) => o.id)).toEqual(['o1', 'o2', 'o3']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body).cursor).toBe('c1');
  });

  it('asks for every location in one query rather than one call each', async () => {
    const fetchMock = respond([{ orders: [] }]);
    await (await createSquareClient(7)).searchOrders(['L1', 'L2', 'L3'], new Date('2026-01-01'));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.location_ids).toEqual(['L1', 'L2', 'L3']);
    // Required by Square whenever the sort field is a closed-at style field,
    // and open tabs are not sales yet regardless.
    expect(body.query.filter.state_filter.states).toEqual(['COMPLETED']);
  });
});

describe('failure modes', () => {
  it('treats 401 as revoked, because tokens are refreshed before they lapse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' }),
    );
    await expect((await createSquareClient(7)).listLocations()).rejects.toBeInstanceOf(
      TokenRevokedError,
    );
  });

  it.each([429, 500, 503])('treats %s as retryable rather than fatal', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => 'busy' }),
    );
    await expect((await createSquareClient(7)).listLocations()).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  it('does not retry a 400, which retrying cannot fix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' }),
    );
    const err = await (await createSquareClient(7)).listLocations().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SquareApiError);
    expect(err).not.toBeInstanceOf(RetryableError);
    expect((err as InstanceType<typeof SquareApiError>).statusCode).toBe(400);
  });
});

describe('token freshness', () => {
  // The case Shopify has no equivalent of: a connection idle past its 30-day
  // access token still holds a valid refresh token, so this is ordinary rather
  // than an error to recover from.
  it('refreshes before calling when the token is at or past expiry', async () => {
    getByIdAndProvider.mockResolvedValue({
      ...connection,
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessToken.mockResolvedValue({
      encryptedAccessToken: 'enc-new',
      encryptedRefreshToken: 'enc-new-refresh',
      accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const fetchMock = respond([{ locations: [] }]);

    await (await createSquareClient(7)).listLocations();

    expect(refreshAccessToken).toHaveBeenCalledWith(7);
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer dec(enc-new)');
  });

  it('leaves a healthy token alone', async () => {
    respond([{ locations: [] }]);
    await (await createSquareClient(7)).listLocations();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // Two calls racing on one expired token must not both refresh: Square rotates
  // the refresh token, so the second exchange would present one Square has
  // already replaced.
  it('refreshes once when two calls race on the same expired token', async () => {
    getByIdAndProvider.mockResolvedValue({
      ...connection,
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    refreshAccessToken.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                encryptedAccessToken: 'enc-new',
                encryptedRefreshToken: 'enc-new-refresh',
                accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              }),
            5,
          ),
        ),
    );
    respond([{ locations: [] }, { orders: [] }]);

    const client = await createSquareClient(7);
    await Promise.all([client.listLocations(), client.searchOrders(['L1'], new Date())]);

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});
