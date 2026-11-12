import type http from 'node:http';

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// The unit tests for this middleware mock redis, so what they can reach is the
// branching: 429 shape, metric increment, bypass. What they cannot reach is
// whether the limit actually holds, because that is a property of the store. The
// interesting cases here are a window that persists across requests and a burst
// that arrives at once, which is how a real abuser behaves and what a per-call
// mock cannot express.
//
// .env.ci sets DISABLE_RATE_LIMIT=true and the module reads it once at import,
// so without this the middleware is a pass-through and every assertion below
// would hold for the wrong reason.
process.env.DISABLE_RATE_LIMIT = 'false';

const { rateLimitAuth, rateLimitPublic } = await import('./rateLimiter.js');
const { createTestApp } = await import('../test/helpers/testApp.js');
const { redis } = await import('../lib/redis.js');
const { RATE_LIMITS } = await import('shared/constants');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  await redis.connect();
  const started = await createTestApp((app) => {
    app.get('/auth-tier', rateLimitAuth, (_req, res) => res.json({ ok: true }));
    app.get('/public-tier', rateLimitPublic, (_req, res) => res.json({ ok: true }));
  });
  server = started.server;
  baseUrl = started.baseUrl;
}, 30_000);

afterAll(async () => {
  server?.close();
  const keys = await redis.keys('rl_*');
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

beforeEach(async () => {
  // Every test shares one source IP, so the budget has to be cleared or the
  // second test starts already spent.
  const keys = await redis.keys('rl_*');
  if (keys.length) await redis.del(...keys);
});

const hit = (path: string) => fetch(`${baseUrl}${path}`).then((r) => r.status);

describe('rate limiter against real redis', () => {
  it('spends the window across requests and then refuses', async () => {
    const max = RATE_LIMITS.auth.max;

    for (let i = 0; i < max; i++) {
      expect(await hit('/auth-tier')).toBe(200);
    }

    const res = await fetch(`${baseUrl}/auth-tier`);
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('RATE_LIMITED');
    // Retry-After is what a well-behaved client waits on, so a missing header is
    // a defect even though the status is right.
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('admits exactly the limit when the whole burst arrives at once', async () => {
    const max = RATE_LIMITS.auth.max;

    // The property a mock cannot express: interleaved consumes against one
    // counter. If the store were read-then-write rather than atomic, more than
    // max would get through.
    const statuses = await Promise.all(
      Array.from({ length: max * 2 }, () => hit('/auth-tier')),
    );

    expect(statuses.filter((s) => s === 200)).toHaveLength(max);
    expect(statuses.filter((s) => s === 429)).toHaveLength(max);
  });

  it('keeps each tier on its own counter', async () => {
    for (let i = 0; i < RATE_LIMITS.auth.max; i++) await hit('/auth-tier');
    expect(await hit('/auth-tier')).toBe(429);

    expect(await hit('/public-tier')).toBe(200);

    // Asserting the 200 alone proves nothing: public allows 60, so it would
    // answer 200 even while sharing auth's spent counter. Giving both tiers the
    // same keyPrefix passed that version of this test. What separates them is
    // that public's own counter reads 1, and with a shared prefix there is no
    // separate counter to read.
    const publicKeys = await redis.keys('rl_public*');
    expect(publicKeys).toHaveLength(1);
    expect(await redis.get(publicKeys[0]!)).toBe('1');

    const authKeys = await redis.keys('rl_auth*');
    expect(authKeys).toHaveLength(1);
    expect(Number(await redis.get(authKeys[0]!))).toBeGreaterThan(RATE_LIMITS.auth.max - 1);
  });

  it('bounds the window with a real TTL, so a spent budget recovers', async () => {
    await hit('/auth-tier');

    const keys = await redis.keys('rl_auth*');
    expect(keys.length).toBeGreaterThan(0);

    const ttl = await redis.ttl(keys[0]!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(RATE_LIMITS.auth.windowMs / 1000);
  });
});
