import type http from 'node:http';

import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The happy path, as far as it can be driven without a Square seller login.
// Everything here is real: the Express chain with cookieParser, the auth
// middleware, Postgres, Redis, the cookie Set-Cookie header and the cookie the
// callback parses back out. Only Square's own token exchange is stubbed, plus
// the two BullMQ side effects, which are a different subsystem's concern.
//
// This is the test the three rounds of unit work could not be: those mocked
// redis with a Map and asserted on handler internals, so neither the cookie
// round trip nor the binding lookup was ever exercised end to end.

const mockExchangeCode = vi.fn();
vi.mock('../services/integrations/square/oauth.js', async () => {
  const real =
    await vi.importActual<typeof import('../services/integrations/square/oauth.js')>(
      '../services/integrations/square/oauth.js',
    );
  return { ...real, exchangeCode: (code: string) => mockExchangeCode(code) };
});
vi.mock('../services/integrations/square/worker.js', () => ({
  enqueueSyncJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/integrations/square/scheduler.js', () => ({
  registerDailySync: vi.fn().mockResolvedValue(undefined),
  removeDailySync: vi.fn().mockResolvedValue(undefined),
}));

// squareGuard answers 501 unless all four are set, and config reads process.env
// at import time, so this has to run before the dynamic imports below. Declared
// here rather than in .env.ci so the test carries its own requirements and
// cannot drift from the CI job's inline env block.
process.env.SQUARE_CLIENT_ID ||= 'sq-test-client-id';
process.env.SQUARE_CLIENT_SECRET ||= 'sq-test-client-secret';
process.env.SQUARE_REDIRECT_URI ||= 'http://localhost:3001/integrations/square/callback';
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);

const { integrationsRouter, integrationsCallbackRouter } = await import('./integrations.js');
const { authMiddleware } = await import('../middleware/authMiddleware.js');
const { signAccessToken } = await import('../services/auth/tokens.js');
const { createTestApp } = await import('../test/helpers/testApp.js');
const { dbAdmin } = await import('../lib/db.js');
const { redis } = await import('../lib/redis.js');
const { orgs, users, userOrgs, integrationConnections } = await import('../db/schema.js');

const suffix = `oauthflow-${process.pid}`;
let server: http.Server;
let baseUrl: string;
let orgId: number;
let userId: number;
let token: string;

beforeAll(async () => {
  await redis.connect();

  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `OAuth Flow Org ${suffix}`, slug: suffix })
    .returning();
  orgId = org!.id;
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `${suffix}@example.com`, name: `OAuth Flow ${suffix}` })
    .returning();
  userId = user!.id;
  await dbAdmin.insert(userOrgs).values({ userId, orgId, role: 'owner' });

  token = await signAccessToken({ userId, orgId, role: 'owner', isAdmin: false });

  const started = await createTestApp((app) => {
    app.use('/integrations', integrationsCallbackRouter);
    app.use('/api/integrations', authMiddleware, integrationsRouter);
  });
  server = started.server;
  baseUrl = started.baseUrl;
}, 30_000);

afterAll(async () => {
  // Guarded: a beforeAll that throws leaves these undefined, and an unguarded
  // delete then fails on a null parameter and buries the real error.
  if (orgId) {
    await dbAdmin.delete(integrationConnections).where(eq(integrationConnections.orgId, orgId));
    await dbAdmin.delete(userOrgs).where(eq(userOrgs.orgId, orgId));
  }
  if (userId) await dbAdmin.delete(users).where(inArray(users.id, [userId]));
  if (orgId) await dbAdmin.delete(orgs).where(eq(orgs.id, orgId));
  server?.close();
  await redis.quit();
});

function nonceFrom(setCookie: string[]): { name: string; value: string } | null {
  for (const c of setCookie) {
    const m = /^square_oauth_nonce=([^;]+)/.exec(c);
    if (m) return { name: 'square_oauth_nonce', value: m[1]! };
  }
  return null;
}

describe('square OAuth flow, real express + redis + postgres', () => {
  it('connect, then callback with the cookie it issued, creates the connection', async () => {
    mockExchangeCode.mockResolvedValueOnce({
      accessToken: 'sq-access',
      refreshToken: 'sq-refresh',
      expiresAt: new Date(Date.now() + 3_600_000),
      merchantId: `merchant-${suffix}`,
      scope: 'ORDERS_READ',
    });

    const connect = await fetch(`${baseUrl}/api/integrations/square/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: `access_token=${token}` },
      body: '{}',
    });
    expect(connect.status).toBe(200);

    const setCookie = connect.headers.getSetCookie();
    const nonce = nonceFrom(setCookie);
    // If this is null the flow is dead on arrival: the callback has nothing to
    // compare against, and no amount of correct server state can rescue it.
    expect(nonce).not.toBeNull();
    expect(nonce!.value).toMatch(/^[0-9a-f]{32}$/);

    const { data } = (await connect.json()) as { data: { authUrl: string } };
    const state = new URL(data.authUrl).searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{48}$/);

    // The browser now carries exactly one cookie back, and the provider echoes
    // the state. Nothing in this request names the org.
    const callback = await fetch(
      `${baseUrl}/integrations/square/callback?code=real-code&state=${state}`,
      { redirect: 'manual', headers: { Cookie: `${nonce!.name}=${nonce!.value}` } },
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe(
      `${process.env.APP_URL}/dashboard?square=connected`,
    );
    expect(mockExchangeCode).toHaveBeenCalledWith('real-code');

    const rows = await dbAdmin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('square');
    // The org came from the redis binding, not from anything the caller sent.
    expect(rows[0]!.orgId).toBe(orgId);
  });

  it('the same callback replayed is refused, because the binding is consumed', async () => {
    // Primed TWICE on purpose. With one value the replayed callback would get
    // undefined back, throw inside encrypt() and redirect to error regardless of
    // whether the binding was consumed, so the test would pass with the deletion
    // removed. Two values make consumption the only thing refusing the replay.
    const tokens = (n: number) => ({
      accessToken: `sq-access-2-${n}`,
      refreshToken: `sq-refresh-2-${n}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      merchantId: `merchant-replay-${n}-${suffix}`,
      scope: 'ORDERS_READ',
    });
    mockExchangeCode.mockResolvedValueOnce(tokens(1)).mockResolvedValueOnce(tokens(2));

    await dbAdmin.delete(integrationConnections).where(eq(integrationConnections.orgId, orgId));

    const connect = await fetch(`${baseUrl}/api/integrations/square/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: `access_token=${token}` },
      body: '{}',
    });
    const nonce = nonceFrom(connect.headers.getSetCookie())!;
    const { data } = (await connect.json()) as { data: { authUrl: string } };
    const state = new URL(data.authUrl).searchParams.get('state');
    const url = `${baseUrl}/integrations/square/callback?code=c&state=${state}`;
    const cookie = { Cookie: `${nonce.name}=${nonce.value}` };

    const first = await fetch(url, { redirect: 'manual', headers: cookie });
    expect(first.headers.get('location')).toMatch(/square=connected$/);

    const second = await fetch(url, { redirect: 'manual', headers: cookie });
    expect(second.headers.get('location')).toMatch(/square=error$/);
    // One flow, one exchange. A second trade would mean the binding survived.
    expect(mockExchangeCode).toHaveBeenCalledTimes(1);
  });

  it('a callback with no cookie is refused even though the state is valid', async () => {
    await dbAdmin.delete(integrationConnections).where(eq(integrationConnections.orgId, orgId));

    // The exchange is primed to SUCCEED. Without this the mock returns
    // undefined, encrypt() throws on it and the handler redirects to error
    // anyway, so the test would pass with the nonce check deleted. Priming it
    // makes the nonce check the only thing standing between this request and a
    // persisted connection.
    mockExchangeCode.mockResolvedValueOnce({
      accessToken: 'sq-access-3',
      refreshToken: 'sq-refresh-3',
      expiresAt: new Date(Date.now() + 3_600_000),
      merchantId: `merchant-nocookie-${suffix}`,
      scope: 'ORDERS_READ',
    });

    const connect = await fetch(`${baseUrl}/api/integrations/square/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: `access_token=${token}` },
      body: '{}',
    });
    const { data } = (await connect.json()) as { data: { authUrl: string } };
    const state = new URL(data.authUrl).searchParams.get('state');

    // This is the cross-tenant attack: the attacker holds a valid state for
    // their own org, the victim's browser holds no nonce for it.
    const callback = await fetch(
      `${baseUrl}/integrations/square/callback?code=victim-code&state=${state}`,
      { redirect: 'manual' },
    );

    expect(callback.headers.get('location')).toMatch(/square=error$/);
    // The code must never be traded, or a victim's tokens exist server side even
    // though the redirect said error.
    expect(mockExchangeCode).not.toHaveBeenCalledWith('victim-code');
    const rows = await dbAdmin
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.orgId, orgId));
    expect(rows).toHaveLength(0);
  });
});
