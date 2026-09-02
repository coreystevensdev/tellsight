import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

// index.ts assembles the app at module scope and calls listen(), so importing it
// starts a server and nothing tests it. The gap is not theoretical: moving the
// webhook routers below express.json() leaves all 2,317 unit tests green, and
// that reordering makes express.raw() a no-op so Stripe signature verification
// fails in production.
//
// stripeWebhook.test.ts does mount the router before the parsers, via the
// beforeParsers hook in testApp.ts. That proves the router works in that
// position; it can never prove index.ts puts it there.
//
// Scanning the source rather than booting the app, for the same reason
// rlsCallSites.test.ts does: it travels with the suite and fails in the same
// place as everything else.

const SOURCE = readFileSync(join(import.meta.dirname ?? __dirname, 'index.ts'), 'utf-8');

function positionOf(marker: string): number {
  const at = SOURCE.indexOf(marker);
  expect(at, `index.ts no longer contains ${marker}`).toBeGreaterThan(-1);
  return at;
}

describe('express middleware chain order', () => {
  // If any of these stops matching, every ordering assertion below compares -1
  // against -1 and passes while checking nothing.
  it('found every marker it asserts on', () => {
    for (const marker of [
      "app.set('trust proxy'",
      'app.use(correlationId)',
      'app.use(stripeWebhookRouter)',
      'app.use(resendWebhookRouter)',
      "app.use(express.json({ limit: '10mb' }))",
      'app.use(cookieParser())',
      'app.use(errorHandler)',
    ]) {
      expect(SOURCE).toContain(marker);
    }
  });

  // The raw-body requirement. express.json() consumes the stream, so a webhook
  // router mounted after it receives a parsed object and express.raw() yields an
  // empty buffer, which fails signature verification for every event.
  it.each(['app.use(stripeWebhookRouter)', 'app.use(resendWebhookRouter)'])(
    'mounts %s before the JSON body parser',
    (router) => {
      expect(positionOf(router)).toBeLessThan(
        positionOf("app.use(express.json({ limit: '10mb' }))"),
      );
    },
  );

  // correlationId has to be first so every later log line, including the webhook
  // routers' own, carries the id.
  it('registers correlationId before the webhook routers', () => {
    expect(positionOf('app.use(correlationId)')).toBeLessThan(
      positionOf('app.use(stripeWebhookRouter)'),
    );
  });

  it('registers the cookie parser after the JSON parser and before the routes', () => {
    expect(positionOf("app.use(express.json({ limit: '10mb' }))")).toBeLessThan(
      positionOf('app.use(cookieParser())'),
    );
    expect(positionOf('app.use(cookieParser())')).toBeLessThan(positionOf('app.use(authRouter)'));
  });

  // Express picks the error handler by arity and only reaches it if it is
  // registered after the route that threw.
  it('registers the error handler last', () => {
    const errorHandler = positionOf('app.use(errorHandler)');
    const laterUse = SOURCE.slice(errorHandler + 'app.use(errorHandler)'.length).indexOf('app.use(');

    expect(laterUse, 'something is registered after errorHandler').toBe(-1);
  });

  it('trusts exactly the documented number of proxy hops', () => {
    expect(SOURCE).toContain("app.set('trust proxy', 2)");
  });
});

describe('metrics endpoint exposure', () => {
  // /metrics carries request volumes, error rates and AI spend. It is mounted
  // before helmet and outside every rate limiter, so the bearer check is the
  // only thing in front of it.
  it('gates /metrics behind a bearer token in production', () => {
    const handler = SOURCE.slice(positionOf("app.get('/metrics'"), positionOf('// request duration histogram'));

    expect(handler).toContain("env.NODE_ENV === 'production'");
    expect(handler).toContain('env.METRICS_TOKEN');
    expect(handler).toContain('res.status(401)');
  });
});
