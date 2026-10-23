import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// shopify.app.toml is what Shopify's servers enforce. SHOPIFY_SCOPES in
// oauth.ts is what this code asks for. Same contract, written twice, and
// nothing checked they agree.
//
// Drift does not throw. Shopify grants whatever the app config says, so asking
// for a scope the config omits returns a thinner payload rather than an error,
// and the sync writes fewer rows while looking healthy. That is why this
// asserts the URL the code actually builds rather than comparing two strings.
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../config.js', () => ({
  env: {
    SHOPIFY_CLIENT_ID: 'test-client-id',
    SHOPIFY_CLIENT_SECRET: 'test-client-secret',
    SHOPIFY_REDIRECT_URI: 'https://tellsight.example.com/api/integrations/shopify/callback',
  },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { generateAuthUrl } = await import('./oauth.js');

// six levels up from services/integrations/shopify to the repo root
const appToml = readFileSync(new URL('../../../../../../shopify.app.toml', import.meta.url), 'utf8');

function tomlValue(key: string): string {
  const m = appToml.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  if (!m) throw new Error(`shopify.app.toml has no ${key}`);
  return m[1]!;
}

describe('shopify.app.toml agrees with the code', () => {
  it('requests exactly the scopes the app is configured to grant', () => {
    const { authUrl } = generateAuthUrl('tellsight-test.myshopify.com');
    const requested = new URL(authUrl).searchParams.get('scope');

    expect(requested).toBe(tomlValue('scopes'));
  });

  // The host differs per environment so only the path is a fixed contract.
  // /api/* has no route handler for the callback, so it falls through the
  // Next.js rewrite, which strips /api and hands it to the Express route at
  // /integrations/shopify/callback. Change either end and Shopify rejects the
  // callback, with the error surfacing on the store's side where it reads like
  // a store problem rather than ours.
  it('points at the callback path the stack actually serves', () => {
    // Scoped to the redirect_urls block: application_url appears earlier in the
    // file and a bare URL match picks that up instead, which passes for the
    // wrong reason.
    const block = appToml.match(/redirect_urls\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    const urls = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.map((u) => new URL(u).pathname)).toContain(
      '/api/integrations/shopify/callback',
    );
  });

  // The client_id is public, it travels in the authorize URL. Pinning it means
  // pointing the repo at a different Shopify app is a visible change rather
  // than a silent one.
  it('declares a client_id', () => {
    expect(tomlValue('client_id')).toMatch(/^[a-f0-9]{32}$/);
  });
});
