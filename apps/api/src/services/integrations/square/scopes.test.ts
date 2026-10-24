import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// An over-requested scope is not a runtime failure, so nothing catches it: the
// seller just sees a consent screen asking for more than the app uses, and
// Shopify's own app linter flags that as a privacy problem. PAYMENTS_READ sat
// in this list unused until it was measured.
//
// An under-requested scope is the opposite failure and much louder, but equally
// invisible here: it surfaces as a runtime refusal the first time real data
// exercises the path, which is how the Shopify customer field got out.
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../config.js', () => ({
  env: {
    SQUARE_CLIENT_ID: 'id',
    SQUARE_CLIENT_SECRET: 'secret',
    SQUARE_REDIRECT_URI: 'https://example.com/cb',
    SQUARE_ENVIRONMENT: 'sandbox',
  },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { squareScopes } = await import('./oauth.js');

// Square documents permissions per endpoint, so the unit that matters is the
// path this code actually calls, read out of the source rather than listed by
// hand where it could drift.
const ENDPOINT_SCOPES: Record<string, string> = {
  '/v2/locations': 'MERCHANT_PROFILE_READ',
  '/v2/orders/search': 'ORDERS_READ',
};

function calledPaths(): string[] {
  const src = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  return [...src.matchAll(/'(\/v2\/[a-z/]+)'/g)].map((m) => m[1]!);
}

const requested = squareScopes().split(' ');

describe('square scopes match the endpoints the code calls', () => {
  it('requests every scope its endpoints need', () => {
    const missing = calledPaths()
      .map((path) => ({ path, scope: ENDPOINT_SCOPES[path] }))
      .filter(({ scope }) => scope && !requested.includes(scope));

    expect(missing).toEqual([]);
  });

  it('requests nothing it does not need', () => {
    const needed = new Set(calledPaths().map((p) => ENDPOINT_SCOPES[p]).filter(Boolean));
    const extra = requested.filter((s) => !needed.has(s));

    expect(extra).toEqual([]);
  });

  // Without this, both assertions above pass when the path regex matches
  // nothing at all, which is the same shape as having no endpoints to check.
  it('actually found the endpoints', () => {
    const paths = calledPaths();
    expect(paths).toContain('/v2/orders/search');
    expect(paths).toContain('/v2/locations');
  });

  it('every known endpoint maps to a scope', () => {
    expect(Object.values(ENDPOINT_SCOPES).every(Boolean)).toBe(true);
  });
});
