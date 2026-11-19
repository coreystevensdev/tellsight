import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetByIdAndProvider = vi.fn();
const mockUpdateSyncStatus = vi.fn();
const mockAdoptRotatedTokens = vi.fn();
const mockCommitRotatedTokens = vi.fn();

vi.mock('../../../config.js', () => ({
  env: {
    XERO_CLIENT_ID: 'client-id',
    XERO_CLIENT_SECRET: 'client-secret',
    XERO_REDIRECT_URI: 'https://app.example.com/api/integrations/xero/callback',
  },
}));
vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getByIdAndProvider: mockGetByIdAndProvider,
    updateSyncStatus: mockUpdateSyncStatus,
  },
}));
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../encryption.js', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('../tokenRotation.js', () => ({
  requireRefreshToken: (c: { encryptedRefreshToken: string | null }) => c.encryptedRefreshToken!,
  adoptRotatedTokens: mockAdoptRotatedTokens,
  commitRotatedTokens: mockCommitRotatedTokens,
}));

const { exchangeCode, fetchTenants, generateAuthUrl, refreshAccessToken, revokeToken } =
  await import('./oauth.js');

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetByIdAndProvider.mockResolvedValue({
    id: 5,
    orgId: 2,
    encryptedRefreshToken: 'enc:old-refresh',
    encryptedAccessToken: 'enc:old-access',
  });
  mockCommitRotatedTokens.mockImplementation(async (_id, _p, _from, rotated) => rotated);
});

describe('generateAuthUrl', () => {
  /**
   * The scope set is a deliberate exclusion, not an oversight.
   *
   * `accounting.contacts.read` would grant the /Contacts endpoint: emails,
   * phone numbers, addresses, bank details. The only thing this product wants
   * from a contact is the name, and that already arrives embedded in every
   * invoice under `accounting.transactions`.
   */
  it('does not ask for contact data it already receives embedded', () => {
    expect(generateAuthUrl().authUrl).not.toContain('accounting.contacts');
  });

  // Without offline_access Xero issues no refresh token at all, so the
  // connection would die 30 minutes after it was made.
  it('asks for offline access, which is what makes a refresh token exist', () => {
    expect(generateAuthUrl().authUrl).toContain('offline_access');
  });

  // A line item carries an account code and not a name, so without this every
  // category on the dashboard reads as a number.
  it('asks for settings, which is what turns an account code into a name', () => {
    expect(generateAuthUrl().authUrl).toContain('accounting.settings.read');
  });

  /**
   * Xero deprecated the broad `accounting.transactions.read` and assigned
   * granular scopes to every Web and PKCE app in March 2026. An app created
   * after that date does not have the broad scope at all, so requesting it
   * fails authorize with `invalid_scope` before the consent screen ever
   * renders. Pinned so nobody "simplifies" four scopes back into one.
   */
  it('asks for granular scopes, not the deprecated broad one', () => {
    const authUrl = generateAuthUrl().authUrl;

    expect(authUrl).not.toContain('accounting.transactions');
    expect(authUrl).toContain('accounting.invoices.read');
    expect(authUrl).toContain('accounting.banktransactions.read');
  });

  /**
   * The other two quarters of the old broad scope, deliberately absent.
   * `sync.ts` fetches neither: a Xero payment settles an invoice `Invoices`
   * already reported, so reading Payments would double-count revenue, and
   * ManualJournals is not fetched at all. Granular scopes made it possible to
   * ask for less than the broad scope forced on us.
   */
  it('does not ask for payments or manual journals it never reads', () => {
    const authUrl = generateAuthUrl().authUrl;

    expect(authUrl).not.toContain('accounting.payments');
    expect(authUrl).not.toContain('accounting.manualjournals');
  });

  /**
   * Xero answered `invalid_scope` on the live consent screen while every
   * assertion above passed.
   *
   * `URLSearchParams` encodes a space as `+`, the form-urlencoded convention,
   * and Xero percent-decodes this query string per RFC 3986 where `+` is a
   * literal plus. The three scopes arrived as one nonsense token. Nothing here
   * could see it, because the string we built was exactly the string we meant
   * to build; only the provider disagreed about how to read it.
   *
   * Square builds its URL identically and is connected in production, so its
   * server form-decodes and the `+` works. That difference is why this went
   * unnoticed, and why asserting on the raw substring matters.
   */
  it('separates scopes with %20, not the + URLSearchParams emits', () => {
    const raw = generateAuthUrl().authUrl.match(/[?&]scope=([^&]*)/)![1]!;

    expect(raw).toContain('%20');
    expect(raw).not.toContain('+');
  });

  // Deliberately paired with the raw check above rather than replacing it.
  // `URL.searchParams` form-decodes, so it reads a `+` back as a space and
  // reports three correct scopes against the broken URL. This asserts what the
  // scopes are; only the raw substring can see how they were encoded.
  it('asks for exactly the three scopes, once decoded', () => {
    const scope = new URL(generateAuthUrl().authUrl).searchParams.get('scope');

    expect(scope!.split(' ')).toEqual([
      'offline_access',
      'accounting.invoices.read',
      'accounting.banktransactions.read',
      'accounting.settings.read',
    ]);
  });

  it('mints a distinct state per call', () => {
    expect(generateAuthUrl().state).not.toBe(generateAuthUrl().state);
  });

  it('sends the state in the url, so the callback can match it', () => {
    const { authUrl, state } = generateAuthUrl();
    expect(authUrl).toContain(`state=${state}`);
  });
});

describe('exchangeCode', () => {
  it('returns the pair and the granted scope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 1800,
        token_type: 'Bearer',
        scope: 'offline_access accounting.transactions.read',
      }),
    );

    await expect(exchangeCode('the-code')).resolves.toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 1800,
      scope: 'offline_access accounting.transactions.read',
    });
  });

  // Asserts against what generateAuthUrl actually asks for rather than a
  // hardcoded copy. The copy went stale the moment Xero deprecated the broad
  // scope, and a fallback that disagrees with the request is a stored `scope`
  // column that lies about what was granted.
  it('falls back to the requested scope when Xero echoes none', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 1800, token_type: 'Bearer' }),
    );

    const requested = new URL(generateAuthUrl().authUrl).searchParams.get('scope');

    expect((await exchangeCode('c')).scope).toBe(requested);
  });

  it('raises an external service error on a rejected exchange', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(exchangeCode('c')).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_ERROR' });
  });
});

describe('fetchTenants', () => {
  const org = {
    tenantId: 'org-1',
    tenantName: 'Maple Florist',
    tenantType: 'ORGANISATION',
  };

  /**
   * A Xero login can authorize a practice workspace as well as a business.
   * Syncing one would produce a dataset with no transactions in it, which
   * reads to the owner as a broken connector rather than the wrong tenant.
   */
  it.each(['PRACTICE', 'PRACTICEMANAGER'])('excludes a %s tenant', async (tenantType) => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ tenantId: 'p-1', tenantName: null, tenantType }, org]),
    );

    expect(await fetchTenants('token')).toEqual([org]);
  });

  it('keeps every organisation the consent covered', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([org, { ...org, tenantId: 'org-2', tenantName: 'Second Co' }]),
    );

    expect((await fetchTenants('token')).map((t) => t.tenantId)).toEqual(['org-1', 'org-2']);
  });

  // Documented as nullable even for an organisation, so it must not disqualify
  // an otherwise usable tenant.
  it('accepts an organisation with no name', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ ...org, tenantName: null }]));

    expect((await fetchTenants('token'))[0]!.tenantName).toBeNull();
  });

  it('skips a tenant with no id, which cannot be synced', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ tenantName: 'Nameless', tenantType: 'ORGANISATION' }, org]),
    );

    expect(await fetchTenants('token')).toEqual([org]);
  });

  // Terminal rather than an empty list: the callback must fail before writing a
  // connection row that can never produce data.
  it('throws when consent covered no organisation at all', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ tenantId: 'p-1', tenantName: null, tenantType: 'PRACTICE' }]),
    );

    await expect(fetchTenants('token')).rejects.toMatchObject({ name: 'XeroNoTenantError' });
  });

  it('throws on an empty tenant list', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await expect(fetchTenants('token')).rejects.toMatchObject({ name: 'XeroNoTenantError' });
  });

  it('sends the bearer token it was handed', async () => {
    fetchMock.mockResolvedValue(jsonResponse([org]));

    await fetchTenants('the-token');

    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-token');
  });
});

describe('refreshAccessToken', () => {
  it('commits the new pair against the token it started from', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 1800, token_type: 'Bearer' }),
    );

    await refreshAccessToken(5);

    expect(mockCommitRotatedTokens).toHaveBeenCalledWith(5, 'xero', 'enc:old-refresh', {
      encryptedAccessToken: 'enc:new-a',
      encryptedRefreshToken: 'enc:new-r',
      accessTokenExpiresAt: expect.any(Date),
    });
  });

  it('sends the decrypted refresh token, not the stored ciphertext', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 1800, token_type: 'Bearer' }),
    );

    await refreshAccessToken(5);

    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(init.body)).toContain('refresh_token=old-refresh');
  });

  /**
   * The decision this file exists for.
   *
   * Xero destroys the previous refresh token the instant a new pair is issued,
   * so a second sync refreshing concurrently gets a rejection that looks
   * exactly like a revocation. Marking the connection broken there would make
   * the owner reconnect for nothing, when the other sync has a perfectly good
   * pair sitting in the row.
   *
   * 400 as well as 401, because Xero answers a spent token with invalid_grant
   * at 400 where Intuit uses 401.
   */
  it.each([400, 401])('adopts the pair the winner wrote when a %s was a lost race', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, status));
    const winner = {
      encryptedAccessToken: 'enc:winner-a',
      encryptedRefreshToken: 'enc:winner-r',
      accessTokenExpiresAt: new Date(),
    };
    mockAdoptRotatedTokens.mockResolvedValueOnce(winner);

    await expect(refreshAccessToken(5)).resolves.toEqual(winner);
    expect(mockUpdateSyncStatus).not.toHaveBeenCalled();
  });

  it.each([400, 401])('marks the connection broken when a %s was a real revocation', async (status) => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, status));
    mockAdoptRotatedTokens.mockResolvedValueOnce(null);

    await expect(refreshAccessToken(5)).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
    });
    expect(mockUpdateSyncStatus).toHaveBeenCalledWith(
      5,
      'error',
      'Xero access was revoked, please reconnect',
      expect.anything(),
    );
  });

  // A 500 is Xero being unwell, not the token being spent, so asking whether
  // somebody else rotated is the wrong question and the connection must not be
  // marked broken over it.
  it('does not treat a server error as a token problem', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    await expect(refreshAccessToken(5)).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
    });
    expect(mockAdoptRotatedTokens).not.toHaveBeenCalled();
    expect(mockUpdateSyncStatus).not.toHaveBeenCalled();
  });

  it('refuses a connection that is gone', async () => {
    mockGetByIdAndProvider.mockResolvedValueOnce(undefined);

    await expect(refreshAccessToken(5)).rejects.toThrow('Connection 5 not found');
  });
});

describe('revokeToken', () => {
  it('posts the decrypted token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await revokeToken('enc:the-refresh');

    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(String(init.body)).toContain('token=the-refresh');
  });

  // Best effort on purpose: the row is being deleted either way, and throwing
  // here would leave the connection in the table with its scheduler removed.
  it('swallows a failure rather than blocking the disconnect', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(revokeToken('enc:r')).resolves.toBeUndefined();
  });
});
