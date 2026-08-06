import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('../../../config.js', () => ({
  env: {
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    SHOPIFY_REDIRECT_URI: 'https://tellsight.example.com/integrations/shopify/callback',
  },
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { isValidShopDomain, generateAuthUrl, verifyHmac } = await import('./oauth.js');

// Mirrors Shopify's own signing algorithm: sort every param except hmac and
// signature, join as key=value pairs with &, HMAC-SHA256 with the client
// secret, hex digest. Used to build test fixtures that should pass verification.
function signQuery(params: Record<string, string>, secret = 'test-client-secret'): string {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHmac('sha256', secret).update(message).digest('hex');
}

describe('isValidShopDomain', () => {
  it.each(['my-store.myshopify.com', 'store123.myshopify.com'])('accepts a real shop domain: %s', (shop) => {
    expect(isValidShopDomain(shop)).toBe(true);
  });

  it.each([
    'my-store.com',
    'https://my-store.myshopify.com',
    'my-store.myshopify.com/admin',
    '../../etc/passwd',
    '',
  ])('rejects a malformed or non-Shopify domain: %s', (shop) => {
    expect(isValidShopDomain(shop)).toBe(false);
  });
});

describe('generateAuthUrl', () => {
  it('builds a per-shop authorize URL with client id, scope, redirect uri, and state', () => {
    const { authUrl, state } = generateAuthUrl('my-store.myshopify.com');
    expect(authUrl).toContain('https://my-store.myshopify.com/admin/oauth/authorize?');
    expect(authUrl).toContain('client_id=test-client-id');
    expect(authUrl).toContain(`state=${state}`);
    expect(authUrl).toContain('read_orders');
  });

  it('generates a different state each call, CSRF protection depends on this', () => {
    const first = generateAuthUrl('my-store.myshopify.com');
    const second = generateAuthUrl('my-store.myshopify.com');
    expect(first.state).not.toBe(second.state);
  });

  it('throws rather than build a URL for an invalid shop domain', () => {
    expect(() => generateAuthUrl('not-a-shop.com')).toThrow();
  });
});

describe('verifyHmac', () => {
  it('accepts a correctly signed query', () => {
    const params = { code: 'abc123', shop: 'my-store.myshopify.com', state: 'xyz', timestamp: '1700000000' };
    const hmac = signQuery(params);
    expect(verifyHmac({ ...params, hmac })).toBe(true);
  });

  it('rejects a query with no hmac param at all', () => {
    expect(verifyHmac({ code: 'abc123', shop: 'my-store.myshopify.com' })).toBe(false);
  });

  it('rejects a query signed with the wrong secret (forged callback)', () => {
    const params = { code: 'abc123', shop: 'my-store.myshopify.com' };
    const hmac = signQuery(params, 'attacker-secret');
    expect(verifyHmac({ ...params, hmac })).toBe(false);
  });

  it('rejects a query where a value was tampered with after signing', () => {
    const params = { code: 'abc123', shop: 'my-store.myshopify.com' };
    const hmac = signQuery(params);
    expect(verifyHmac({ ...params, shop: 'attacker-store.myshopify.com', hmac })).toBe(false);
  });

  it("excludes both hmac and signature from the signed message, matching Shopify's own scheme", () => {
    const params = { code: 'abc123', shop: 'my-store.myshopify.com' };
    const hmac = signQuery(params);
    // signature is an extra param a forged request could add; it must not
    // change the outcome since Shopify's own algorithm ignores it too
    expect(verifyHmac({ ...params, hmac, signature: 'whatever' })).toBe(true);
  });
});
