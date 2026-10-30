import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  getByIdAndProvider: vi.fn(),
  updateSyncStatus: vi.fn(),
  updateTokens: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

const env = vi.hoisted(() => ({
  QUICKBOOKS_CLIENT_ID: 'quickbooks-client-id',
  QUICKBOOKS_CLIENT_SECRET: 'quickbooks-client-secret',
  QUICKBOOKS_REDIRECT_URI: 'https://tellsight.example.com/integrations/quickbooks/callback',
}));

vi.mock('../../../config.js', () => ({ env }));
// oauth.ts uses the admin client for connector state, but these focused tests
// should never create a real Postgres pool.
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn, error: mocks.loggerError },
}));
vi.mock('../encryption.js', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
}));
vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mocks.getByIdAndProvider,
    updateSyncStatus: mocks.updateSyncStatus,
    updateTokens: mocks.updateTokens,
  },
}));

const { exchangeCode, generateAuthUrl, refreshAccessToken, revokeToken } =
  await import('./oauth.js');

const TOKEN_RESPONSE = {
  access_token: 'new-access-token',
  refresh_token: 'new-refresh-token',
  expires_in: 3_600,
  token_type: 'bearer',
  x_refresh_token_expires_in: 8_726_400,
};

const CONNECTION = {
  id: 42,
  encryptedRefreshToken: 'encrypted-old-refresh-token',
};

function responseOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestFrom(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url, init: init as RequestInit };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getByIdAndProvider.mockResolvedValue(CONNECTION);
  mocks.decrypt.mockReturnValue('old-refresh-token');
  mocks.encrypt.mockImplementation((value: string) => `encrypted:${value}`);
  mocks.updateSyncStatus.mockResolvedValue(undefined);
  mocks.updateTokens.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generateAuthUrl', () => {
  it('builds the Intuit authorize URL with accounting scope and a fresh state', () => {
    const first = generateAuthUrl();
    const second = generateAuthUrl();

    expect(first.state).toMatch(/^[a-f0-9]{48}$/);
    expect(second.state).not.toBe(first.state);

    const url = new URL(first.authUrl);
    expect(url.origin).toBe('https://appcenter.intuit.com');
    expect(url.pathname).toBe('/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('quickbooks-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(env.QUICKBOOKS_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('state')).toBe(first.state);
  });
});

describe('exchangeCode', () => {
  it('exchanges an authorization code with Basic authentication', async () => {
    const fetchMock = responseOnce(TOKEN_RESPONSE);

    await expect(exchangeCode('authorization-code', 'realm-123')).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3_600,
      realmId: 'realm-123',
    });

    const { url, init } = requestFrom(fetchMock);
    expect(url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from('quickbooks-client-id:quickbooks-client-secret').toString('base64')}`,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'authorization-code',
      redirect_uri: env.QUICKBOOKS_REDIRECT_URI,
    });
  });

  it('logs and throws an external-service error on a non-2xx response', async () => {
    responseOnce('invalid authorization code', false, 400);

    await expect(exchangeCode('bad-code', 'realm-123')).rejects.toMatchObject({
      service: 'Intuit OAuth',
      details: { status: 400 },
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { status: 400, body: 'invalid authorization code' },
      'Intuit token exchange failed',
    );
  });
});

describe('refreshAccessToken', () => {
  it('rotates, encrypts, and persists both tokens with the computed expiry', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const fetchMock = responseOnce(TOKEN_RESPONSE);

    const result = await refreshAccessToken(42);

    expect(mocks.getByIdAndProvider).toHaveBeenCalledWith(42, 'quickbooks', {});
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-old-refresh-token');

    const { init } = requestFrom(fetchMock);
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh-token',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const expectedExpiry = new Date(1_800_003_600_000);
    expect(mocks.encrypt.mock.calls.map(([value]) => value)).toEqual([
      'new-access-token',
      'new-refresh-token',
    ]);
    expect(mocks.updateTokens).toHaveBeenCalledWith(
      42,
      'encrypted:new-access-token',
      'encrypted:new-refresh-token',
      expectedExpiry,
      {},
    );
    expect(result).toEqual({
      encryptedAccessToken: 'encrypted:new-access-token',
      encryptedRefreshToken: 'encrypted:new-refresh-token',
      accessTokenExpiresAt: expectedExpiry,
    });
  });

  it('fails before calling Intuit when the connection no longer exists', async () => {
    mocks.getByIdAndProvider.mockResolvedValueOnce(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(refreshAccessToken(404)).rejects.toThrow('Connection 404 not found');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('marks a revoked connection as errored and does not persist tokens', async () => {
    responseOnce('refresh token revoked', false, 401);

    await expect(refreshAccessToken(42)).rejects.toMatchObject({
      service: 'Intuit OAuth, token revoked',
      details: { status: 401 },
    });
    expect(mocks.updateSyncStatus).toHaveBeenCalledWith(
      42,
      'error',
      'QuickBooks access was revoked, please reconnect',
      {},
    );
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('keeps transient upstream failures retryable without changing connection status', async () => {
    responseOnce('temporarily unavailable', false, 503);

    await expect(refreshAccessToken(42)).rejects.toMatchObject({
      service: 'Intuit OAuth',
      details: { status: 503 },
    });
    expect(mocks.updateSyncStatus).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });
});

describe('revokeToken', () => {
  it('decrypts and revokes the refresh token with application credentials', async () => {
    const fetchMock = responseOnce({});

    await revokeToken('encrypted-refresh-token');

    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-refresh-token');
    const { url, init } = requestFrom(fetchMock);
    expect(url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Basic ${Buffer.from('quickbooks-client-id:quickbooks-client-secret').toString('base64')}`,
    });
    expect(init.body).toBe(JSON.stringify({ token: 'old-refresh-token' }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('swallows a network failure because revocation is best effort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    await expect(revokeToken('encrypted-refresh-token')).resolves.toBeUndefined();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'network down' }) },
      'Intuit token revocation failed, best effort',
    );
  });

  it('also swallows a local decryption failure without making a request', async () => {
    const error = new Error('invalid encrypted token');
    mocks.decrypt.mockImplementationOnce(() => {
      throw error;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeToken('malformed')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { err: error },
      'Intuit token revocation failed, best effort',
    );
  });
});
