import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const env: Record<string, string> = {
  SQUARE_CLIENT_ID: 'test-client-id',
  SQUARE_CLIENT_SECRET: 'test-client-secret',
  SQUARE_REDIRECT_URI: 'https://tellsight.example.com/integrations/square/callback',
  SQUARE_ENVIRONMENT: 'sandbox',
};

vi.mock('../../../config.js', () => ({ env }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { generateAuthUrl, exchangeCode, refreshTokens, revokeToken, apiHost, squareScopes } =
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
    expect(squareScopes()).toBe('ORDERS_READ PAYMENTS_READ MERCHANT_PROFILE_READ');
  });
});
