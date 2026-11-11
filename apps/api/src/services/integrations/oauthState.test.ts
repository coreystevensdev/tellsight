import { describe, it, expect, beforeEach, vi } from 'vitest';

// A real map rather than per-call stubs: the properties worth pinning here are
// about what survives a put/take round trip and what a second take sees, and
// stubbed return values would let the module pass while storing nothing.
const store = new Map<string, string>();
const redis = {
  set: vi.fn(async (k: string, v: string) => {
    store.set(k, v);
    return 'OK';
  }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
};
vi.mock('../../lib/redis.js', () => ({ redis }));

const { putOAuthState, takeOAuthState, nonceMatches, newOAuthNonce, oauthNonceCookie } =
  await import('./oauthState.js');

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('OAuth flow binding', () => {
  it('returns the org and user that started the flow', async () => {
    await putOAuthState('quickbooks', 'state-abc', { orgId: 7, userId: 42, nonce: 'n' });

    await expect(takeOAuthState('quickbooks', 'state-abc')).resolves.toEqual({ orgId: 7, userId: 42, nonce: 'n' });
  });

  it('the caller cannot influence which org comes back', async () => {
    // This is the defect. The org used to arrive on a `qb_oauth_org_id` cookie
    // that the callback read straight into an RLS-bypassing upsert, so editing
    // it mid-flow aimed the write at any org id. Here the only input is the
    // state, and the org is whatever /connect stored against it.
    await putOAuthState('quickbooks', 'state-victim', { orgId: 1, userId: 1, nonce: 'n' });

    const flow = await takeOAuthState('quickbooks', 'state-victim');

    expect(flow?.orgId).toBe(1);
    expect(takeOAuthState.length).toBe(2); // provider and state, no org parameter to pass
  });

  it('a state is single use, so a replayed callback finds nothing', async () => {
    await putOAuthState('square', 'state-once', { orgId: 3, userId: 9, nonce: 'n' });

    await expect(takeOAuthState('square', 'state-once')).resolves.toEqual({ orgId: 3, userId: 9, nonce: 'n' });
    await expect(takeOAuthState('square', 'state-once')).resolves.toBeNull();
  });

  it('deletes the key even when the state is unknown, so a probe leaves nothing behind', async () => {
    await takeOAuthState('shopify', 'never-minted');

    expect(redis.del).toHaveBeenCalledWith('oauth:state:shopify:never-minted');
  });

  it('a state minted for one provider does not resolve for another', async () => {
    await putOAuthState('shopify', 'shared-value', { orgId: 5, userId: 5, nonce: 'n' });

    await expect(takeOAuthState('square', 'shared-value')).resolves.toBeNull();
    await expect(takeOAuthState('shopify', 'shared-value')).resolves.toEqual({ orgId: 5, userId: 5, nonce: 'n' });
  });

  it('treats a missing state as a failed flow rather than a lookup', async () => {
    await expect(takeOAuthState('quickbooks', undefined)).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('rejects a stored payload that is not two integers', async () => {
    // Nothing should be able to write these keys but the module itself. If
    // something does, a half-valid payload must not become an orgId.
    store.set('oauth:state:square:corrupt', '{"orgId":"1","userId":2}');
    store.set('oauth:state:square:garbage', 'not json');

    await expect(takeOAuthState('square', 'corrupt')).resolves.toBeNull();
    await expect(takeOAuthState('square', 'garbage')).resolves.toBeNull();
  });

  it('expires the binding so an abandoned flow cannot be completed later', async () => {
    await putOAuthState('quickbooks', 'state-ttl', { orgId: 2, userId: 2, nonce: 'n' });

    expect(redis.set).toHaveBeenCalledWith(
      'oauth:state:quickbooks:state-ttl',
      JSON.stringify({ orgId: 2, userId: 2, nonce: 'n' }),
      'EX',
      600,
    );
  });

  it('rejects a stored binding with no nonce, rather than treating it as bound', async () => {
    // A binding written before the nonce existed, or by anything that skipped it.
    store.set('oauth:state:quickbooks:legacy', JSON.stringify({ orgId: 4, userId: 4 }));

    expect(await takeOAuthState('quickbooks', 'legacy')).toBeNull();
  });
});

describe('nonceMatches', () => {
  it('accepts the exact value and nothing else', () => {
    expect(nonceMatches('abc123', 'abc123')).toBe(true);
    expect(nonceMatches('abc124', 'abc123')).toBe(false);
  });

  it('is false for a missing cookie, which is the attack case', () => {
    expect(nonceMatches(undefined, 'abc123')).toBe(false);
    expect(nonceMatches('', 'abc123')).toBe(false);
  });

  it('returns false on a length mismatch instead of throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the guard has to come first
    // or a short cookie would 500 the callback rather than redirect.
    expect(() => nonceMatches('short', 'muchlongervalue')).not.toThrow();
    expect(nonceMatches('short', 'muchlongervalue')).toBe(false);
  });
});

describe('newOAuthNonce', () => {
  it('is 128 bits of hex and differs every call', () => {
    const a = newOAuthNonce();
    const b = newOAuthNonce();

    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('oauthNonceCookie', () => {
  it('is per provider, so two flows at once do not overwrite each other', () => {
    expect(oauthNonceCookie('quickbooks')).toBe('quickbooks_oauth_nonce');
    expect(oauthNonceCookie('shopify')).toBe('shopify_oauth_nonce');
    expect(oauthNonceCookie('square')).toBe('square_oauth_nonce');
  });
});
