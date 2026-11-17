import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const env: Record<string, string> = {
  SQUARE_CLIENT_ID: 'test-client-id',
  SQUARE_CLIENT_SECRET: 'test-client-secret',
  SQUARE_REDIRECT_URI: 'https://tellsight.example.com/integrations/square/callback',
  SQUARE_ENVIRONMENT: 'sandbox',
};

vi.mock('../../../config.js', () => ({ env }));
// lib/db.ts opens two postgres clients at module load, and this subject now
// imports dbAdmin. Without this the suite leaks a pool per test file.
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// refreshAccessToken had no test before DW-283, which is why wiring it to the
// rotation helper broke nothing here. Reaching it needs the queries and the
// encryption boundary stubbed.
const queries = {
  getByIdAndProvider: vi.fn(),
  updateTokens: vi.fn(),
  updateTokensIfUnchanged: vi.fn(),
  updateSyncStatus: vi.fn(),
};
vi.mock('../../../db/queries/index.js', () => ({ integrationConnectionsQueries: queries }));
vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

const { generateAuthUrl, exchangeCode, refreshTokens, revokeToken, apiHost, squareScopes, refreshAccessToken } =
  await import('./oauth.js');

function jsonOnce(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const TOKENS = {
  access_token: 'sq-access',
  refresh_token: 'sq-refresh',
  merchant_id: 'MERCHANT123',
  expires_at: '2026-10-15T22:19:44Z',
};

beforeEach(() => {
  env.SQUARE_ENVIRONMENT = 'sandbox';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiHost', () => {
  // Square serves sandbox from a different host entirely rather than a flag on
  // the request, so pointing at the wrong one fails as an auth error and reads
  // like bad credentials.
  it('separates sandbox from production', () => {
    expect(apiHost()).toBe('https://connect.squareupsandbox.com');
    env.SQUARE_ENVIRONMENT = 'production';
    expect(apiHost()).toBe('https://connect.squareup.com');
  });
});

describe('generateAuthUrl', () => {
  it('requests only read scopes and a fresh state each time', () => {
    const a = generateAuthUrl();
    const b = generateAuthUrl();
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(32);

    const url = new URL(a.authUrl);
    expect(url.origin).toBe('https://connect.squareupsandbox.com');
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('state')).toBe(a.state);
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    // Square requires this false for production apps.
    expect(url.searchParams.get('session')).toBe('false');

    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toContain('ORDERS_READ');
    // Not vanity: a seller-scoped token carries no location id, and
    // SearchOrders needs one, so ListLocations has to be callable.
    expect(scopes).toContain('MERCHANT_PROFILE_READ');
    expect(scopes.every((s) => s.endsWith('_READ'))).toBe(true);
  });
});

describe('exchangeCode', () => {
  it('reads the absolute expiry Square returns, not a lifetime in seconds', async () => {
    jsonOnce(TOKENS);
    const t = await exchangeCode('auth-code');

    expect(t.accessToken).toBe('sq-access');
    expect(t.refreshToken).toBe('sq-refresh');
    expect(t.merchantId).toBe('MERCHANT123');
    expect(t.expiresAt.toISOString()).toBe('2026-10-15T22:19:44.000Z');
  });

  it('sends the authorization_code grant to the token endpoint', async () => {
    const fetchMock = jsonOnce(TOKENS);
    await exchangeCode('auth-code');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://connect.squareupsandbox.com/oauth2/token');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.grant_type).toBe('authorization_code');
    expect(body.code).toBe('auth-code');
    expect(body.client_secret).toBe('test-client-secret');
  });

  // Silently treating an unreadable expiry as "far away" produces a connection
  // that works for 30 days and then stops, with nothing pointing at the cause.
  it('throws rather than guessing when expires_at is unparseable', async () => {
    jsonOnce({ ...TOKENS, expires_at: 'whenever' });
    await expect(exchangeCode('auth-code')).rejects.toThrow(/Square OAuth/);
  });

  it('throws when the response is missing a token field', async () => {
    jsonOnce({ access_token: 'sq-access', merchant_id: 'M1' });
    await expect(exchangeCode('auth-code')).rejects.toThrow(/Square OAuth/);
  });

  it('throws on a non-2xx response', async () => {
    jsonOnce({ message: 'bad code' }, false, 400);
    await expect(exchangeCode('auth-code')).rejects.toThrow(/Square OAuth/);
  });
});

describe('refreshTokens', () => {
  it('sends the refresh_token grant', async () => {
    const fetchMock = jsonOnce(TOKENS);
    await refreshTokens('old-refresh');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('old-refresh');
    expect(body.code).toBeUndefined();
  });
});

describe('revokeToken', () => {
  // Revoking authenticates as the application, so the header is `Client
  // <secret>`. Sending Bearer here fails and the token stays live at Square
  // even though the local row is gone.
  it('authenticates as the application, not as the seller', async () => {
    const fetchMock = jsonOnce({ success: true });
    await revokeToken('sq-access');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://connect.squareupsandbox.com/oauth2/revoke');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Client test-client-secret');
  });

  it('swallows a failure because the local row is deleted either way', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(revokeToken('sq-access')).resolves.toBeUndefined();
  });
});

describe('squareScopes', () => {
  it('space-separates, which is what the authorize endpoint expects', () => {
    expect(squareScopes()).toBe('ORDERS_READ MERCHANT_PROFILE_READ');
  });
});

describe('refreshAccessToken, when another refresh raced it (DW-283)', () => {
  const STORED = {
    id: 7,
    encryptedAccessToken: 'enc:old-access',
    encryptedRefreshToken: 'enc:old-refresh',
    accessTokenExpiresAt: new Date('2026-11-17T09:00:00Z'),
  };

  beforeEach(() => {
    Object.values(queries).forEach((m) => m.mockReset());
    queries.getByIdAndProvider.mockResolvedValue({ ...STORED });
    queries.updateTokensIfUnchanged.mockResolvedValue(true);
    queries.updateTokens.mockResolvedValue(undefined);
    queries.updateSyncStatus.mockResolvedValue(undefined);
  });

  it('writes the new pair as a compare-and-set against the token it started from', async () => {
    jsonOnce(TOKENS);

    await refreshAccessToken(7);

    expect(queries.updateTokensIfUnchanged).toHaveBeenCalledWith(
      7,
      'enc:old-refresh',
      'enc:sq-access',
      'enc:sq-refresh',
      expect.any(Date),
      expect.anything(),
    );
  });

  // The case that bricks a connection on a rotating provider. Square rejecting
  // the token is indistinguishable from a revocation at the HTTP layer, so
  // without this the row is marked broken and the seller reconnects for nothing.
  it('adopts the winner tokens instead of marking the connection revoked', async () => {
    jsonOnce({ error: 'invalid_grant' }, false, 400);
    queries.getByIdAndProvider
      .mockResolvedValueOnce({ ...STORED })
      .mockResolvedValueOnce({
        ...STORED,
        encryptedAccessToken: 'enc:winner-access',
        encryptedRefreshToken: 'enc:winner-refresh',
      });

    const result = await refreshAccessToken(7);

    expect(result.encryptedAccessToken).toBe('enc:winner-access');
    expect(queries.updateSyncStatus).not.toHaveBeenCalled();
  });

  // And the other side of it: an unmoved token means the rejection was real.
  it('still marks the connection revoked when nothing rotated', async () => {
    jsonOnce({ error: 'invalid_grant' }, false, 400);

    await expect(refreshAccessToken(7)).rejects.toThrow();
    expect(queries.updateSyncStatus).toHaveBeenCalledWith(
      7,
      'error',
      expect.stringContaining('reconnect'),
      expect.anything(),
    );
  });
});
