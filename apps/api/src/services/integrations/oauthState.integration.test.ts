import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// The unit tests for this module stand an in-memory Map in for redis and call
// put/take in sequence. That cannot answer the two questions that decide whether
// the OAuth flow binding is actually single-use: whether the key really expires,
// and what happens when two callbacks arrive for the same state at once. A
// provider retry, a double-clicked redirect and two tabs all produce that race.
import { redis } from '../../lib/redis.js';
import { putOAuthState, takeOAuthState, newOAuthNonce } from './oauthState.js';

const keys: string[] = [];
const state = (n: string) => `itest-${process.pid}-${n}`;

// The client is lazyConnect with enableOfflineQueue false, so a command issued
// before the connection is up fails outright rather than queueing. index.ts
// connects at startup; a test has to do the same.
beforeAll(async () => {
  await redis.connect();
  expect(await redis.ping()).toBe('PONG');
});

afterAll(async () => {
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

beforeEach(() => {
  keys.length = 0;
});

describe('oauthState against real redis', () => {
  it('round trips the binding through an actual redis key', async () => {
    const s = state('round-trip');
    keys.push(`oauth:state:square:${s}`);
    const nonce = newOAuthNonce();

    await putOAuthState('square', s, { orgId: 42, userId: 7, nonce });

    const raw = await redis.get(`oauth:state:square:${s}`);
    expect(JSON.parse(raw!)).toEqual({ orgId: 42, userId: 7, nonce });
    expect(await takeOAuthState('square', s)).toEqual({ orgId: 42, userId: 7, nonce });
  });

  it('sets a real TTL, so an abandoned flow cannot be resumed days later', async () => {
    const s = state('ttl');
    keys.push(`oauth:state:quickbooks:${s}`);

    await putOAuthState('quickbooks', s, { orgId: 1, userId: 1, nonce: 'n' });

    const ttl = await redis.ttl(`oauth:state:quickbooks:${s}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('is single use under a concurrent race, not just in sequence', async () => {
    const s = state('race');
    keys.push(`oauth:state:shopify:${s}`);
    const nonce = newOAuthNonce();

    await putOAuthState('shopify', s, { orgId: 99, userId: 5, nonce });

    // Both callbacks start before either finishes, which is what a provider
    // retry or a second tab produces.
    const [a, b] = await Promise.all([
      takeOAuthState('shopify', s),
      takeOAuthState('shopify', s),
    ]);

    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
  });

  it('leaves no key behind after a take', async () => {
    const s = state('cleanup');
    await putOAuthState('square', s, { orgId: 3, userId: 3, nonce: 'n' });
    await takeOAuthState('square', s);

    expect(await redis.exists(`oauth:state:square:${s}`)).toBe(0);
  });
});
