import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import type { AddressInfo } from 'node:net';

// integrations.test.ts mocks isQbConfigured and isShopifyConfigured to true, so
// nothing there ever reaches the 501 guards. Deleting both left all 2,483 API
// tests green, which matters because "both connectors are gated off in
// production" is a safety property the product leans on: the partner credentials
// have not been issued, and the guard is the only thing standing between a
// partial credential set in the environment and a connector coming half-open.
//
// Separate file rather than a module-registry dance inside the other one: the
// whole point is the opposite configuration.

vi.mock('../config.js', () => ({
  env: { APP_URL: 'http://localhost:3000', NODE_ENV: 'test' },
  isQbConfigured: () => false,
  isShopifyConfigured: () => false,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnValue({}) },
}));

const { integrationsRouter, integrationsCallbackRouter } = await import('./integrations.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The real router expects authMiddleware to have run. An unconfigured
  // connector has to answer 501 before it looks at anything else, so a caller
  // that is fully authenticated is the harder case to get right.
  app.use((req: Request, _res: Response, next) => {
    const now = Math.floor(Date.now() / 1000);
    (req as Request & { user?: unknown }).user = {
      sub: '1',
      org_id: 10,
      role: 'owner' as const,
      isAdmin: false,
      iat: now,
      exp: now + 900,
    };
    next();
  });
  app.use('/integrations', integrationsRouter);
  app.use('/integrations', integrationsCallbackRouter);

  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const GATED = [
  ['POST', '/integrations/quickbooks/connect'],
  ['GET', '/integrations/quickbooks/status'],
  ['POST', '/integrations/quickbooks/sync'],
  ['DELETE', '/integrations/quickbooks'],
  ['GET', '/integrations/quickbooks/callback'],
  ['POST', '/integrations/shopify/connect'],
  ['GET', '/integrations/shopify/status'],
  ['POST', '/integrations/shopify/sync'],
  ['DELETE', '/integrations/shopify'],
  ['GET', '/integrations/shopify/callback'],
] as const;

describe('connector routes with no partner credentials configured', () => {
  it.each(GATED)('%s %s answers 501', async (method, path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  // The callback routes are the ones that matter most: they are where an
  // unauthenticated third party can reach the app, so a half-open connector
  // there hands `shop` and `code` to an exchange that would run with the app's
  // own client secret.
  it('refuses the OAuth callbacks before reading any query parameter', async () => {
    const res = await fetch(
      `${baseUrl}/integrations/shopify/callback?shop=evil.myshopify.com&code=x&state=y&hmac=z`,
    );

    expect(res.status).toBe(501);
  });
});
