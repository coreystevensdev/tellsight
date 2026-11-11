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

const { putOAuthState, takeOAuthState } = await import('./oauthState.js');

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('OAuth flow binding', () => {
  it('returns the org and user that started the flow', async () => {
    await putOAuthState('quickbooks', 'state-abc', { orgId: 7, userId: 42 });

    await expect(takeOAuthState('quickbooks', 'state-abc')).resolves.toEqual({ orgId: 7, userId: 42 });
  });

  it('the caller cannot influence which org comes back', async () => {
    // This is the defect. The org used to arrive on a `qb_oauth_org_id` cookie
    // that the callback read straight into an RLS-bypassing upsert, so editing
    // it mid-flow aimed the write at any org id. Here the only input is the
    // state, and the org is whatever /connect stored against it.
    await putOAuthState('quickbooks', 'state-victim', { orgId: 1, userId: 1 });

    const flow = await takeOAuthState('quickbooks', 'state-victim');

    expect(flow?.orgId).toBe(1);
    expect(takeOAuthState.length).toBe(2); // provider and state, no org parameter to pass
  });

  it('a state is single use, so a replayed callback finds nothing', async () => {
    await putOAuthState('square', 'state-once', { orgId: 3, userId: 9 });

    await expect(takeOAuthState('square', 'state-once')).resolves.toEqual({ orgId: 3, userId: 9 });
    await expect(takeOAuthState('square', 'state-once')).resolves.toBeNull();
  });

  it('deletes the key even when the state is unknown, so a probe leaves nothing behind', async () => {
    await takeOAuthState('shopify', 'never-minted');

    expect(redis.del).toHaveBeenCalledWith('oauth:state:shopify:never-minted');
  });

  it('a state minted for one provider does not resolve for another', async () => {
    await putOAuthState('shopify', 'shared-value', { orgId: 5, userId: 5 });

    await expect(takeOAuthState('square', 'shared-value')).resolves.toBeNull();
    await expect(takeOAuthState('shopify', 'shared-value')).resolves.toEqual({ orgId: 5, userId: 5 });
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
    await putOAuthState('quickbooks', 'state-ttl', { orgId: 2, userId: 2 });

    expect(redis.set).toHaveBeenCalledWith(
      'oauth:state:quickbooks:state-ttl',
      JSON.stringify({ orgId: 2, userId: 2 }),
      'EX',
      600,
    );
  });
});
