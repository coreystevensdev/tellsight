import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type http from 'node:http';

// This gate used to live inline in index.ts, which calls listen() at module
// scope, so nothing could import it and the only available check was that
// certain substrings appeared in the source. That would have passed against
// `if (env.NODE_ENV === 'production' && false)`. Source scanning is fine for
// positional invariants like middleware ordering; it cannot establish that a
// guard is enforced.

const TOKEN = 'metrics-token-that-is-long-enough';
const env = { NODE_ENV: 'production', METRICS_TOKEN: TOKEN };

vi.mock('../config.js', () => ({ env }));

vi.mock('../lib/metrics.js', () => ({
  registry: {
    contentType: 'text/plain; version=0.0.4',
    metrics: async () => 'tellsight_ai_spend_usd 12.34\n',
  },
}));

const { createTestApp } = await import('../test/helpers/testApp.js');
const { metricsRouter, isAuthorized } = await import('./metrics.js');

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const result = await createTestApp((app) => {
    app.use(metricsRouter);
  });
  server = result.server;
  baseUrl = result.baseUrl;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function scrape(authorization?: string) {
  return fetch(`${baseUrl}/metrics`, {
    headers: authorization ? { authorization } : {},
  });
}

describe('/metrics in production', () => {
  it('serves the registry to a correct bearer token', async () => {
    const res = await scrape(`Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('tellsight_ai_spend_usd');
  });

  // Each of these is a distinct way the check could be written wrong, and the
  // body assertion matters as much as the status: the point is that operational
  // data does not leak, not merely that a number comes back.
  it.each([
    ['no header at all', undefined],
    ['an empty bearer', 'Bearer '],
    ['the wrong token', 'Bearer not-the-token-at-all-padding'],
    ['a wrong token of exactly the right length', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['a token differing only in the last byte', `Bearer ${TOKEN.slice(0, -1)}X`],
    ['the right token without the scheme', TOKEN],
    ['a different scheme', `Basic ${TOKEN}`],
    ['a prefix of the real token', `Bearer ${TOKEN.slice(0, 10)}`],
    ['the real token plus a suffix', `Bearer ${TOKEN}x`],
    ['lowercase scheme', `bearer ${TOKEN}`],
  ])('refuses %s', async (_label, header) => {
    const res = await scrape(header);

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('tellsight_ai_spend_usd');
  });
});

describe('/metrics outside production', () => {
  // Local docker-compose and CI scrape without a token on purpose.
  it('serves without a token when NODE_ENV is not production', async () => {
    const original = env.NODE_ENV;
    env.NODE_ENV = 'development';

    try {
      const res = await scrape();
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('tellsight_ai_spend_usd');
    } finally {
      env.NODE_ENV = original;
    }
  });
});

describe('isAuthorized with no token configured', () => {
  // Not reachable over HTTP: Node's parser trims trailing whitespace, so
  // `Authorization: Bearer ` arrives as `Bearer` and fails the scheme check
  // before this matters. Verified, not assumed. So the predicate is called
  // directly, because the case is real even though no client can produce it.
  it('refuses an empty credential rather than matching an empty token', () => {
    const original = env.METRICS_TOKEN;
    env.METRICS_TOKEN = '';

    try {
      expect(isAuthorized('Bearer ')).toBe(false);
      expect(isAuthorized(`Bearer ${TOKEN}`)).toBe(false);
    } finally {
      env.METRICS_TOKEN = original;
    }
  });

  it('accepts the configured token when one is set', () => {
    expect(isAuthorized(`Bearer ${TOKEN}`)).toBe(true);
  });
});
