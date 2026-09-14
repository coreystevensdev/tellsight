import { test, expect } from '@playwright/test';
import { authenticateAs } from './helpers/auth';
import { ensureTestUser, TEST_USER } from './helpers/fixtures';

// A page that asks for something it is not allowed to have, handles the refusal
// gracefully and renders anyway is the shape of every silent bug found in this
// codebase so far. useSubscription read a 401 as "free" and downgraded paying
// customers. LastDigestIndicator read one as "no digest" and rendered nothing.
// Both were invisible to the suite, because nothing was broken in a sense a unit
// test can express: the component did exactly what it was told to do with a
// failure it should never have provoked.
//
// The generalisation is cheap. A signed-out visitor on a public page should not
// provoke a single failing response. Anything that does is either a request that
// should not have been made, or a permission that should have been granted, and
// both are worth knowing about before a customer finds them.
const PUBLIC_ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/login', name: 'login' },
  { path: '/signup', name: 'signup' },
  { path: '/forgot-password', name: 'forgot password' },
  { path: '/dashboard', name: 'dashboard' },
];

for (const route of PUBLIC_ROUTES) {
  test(`${route.name} makes no failing requests for a signed-out visitor`, async ({ page, baseURL }) => {
    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    const failures: string[] = [];

    page.on('response', (response) => {
      const url = new URL(response.url());
      // Same-origin only. A font CDN having a bad day is not this app's defect
      // and would make the gate flaky for a reason nobody can act on.
      if (url.origin !== origin) return;
      if (response.status() >= 400) {
        failures.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      }
    });

    await page.goto(route.path);
    await page.locator('h1').first().waitFor({ timeout: 15_000 });
    // Client-side fetches fire after hydration, which is exactly where this class
    // of bug lives, so waiting for the document alone would miss all of them.
    await page.waitForLoadState('networkidle');

    expect(failures).toEqual([]);
  });
}

// Signed-out was only ever half of it. A signed-in owner spends their time on
// /upload, /billing and the settings pages, and none of those were covered.
//
// Three responses here are allowed, and the distinction is the whole point of
// this file. A 401 on the public dashboard was a defect because the client knew
// perfectly well nobody was signed in and asked anyway. These three are the
// opposite: the response IS how the client learns the answer, because nothing
// else tells it. The Agent entitlement is exposed nowhere in the API surface,
// which is why useQaAnswer reads AGENT_TIER_REQUIRED off the 403 body, and the
// connector gate answers 501 precisely so a caller can tell a switched-off
// integration from a broken one.
//
// The list is deliberately three exact pairs rather than a rule. A new failing
// request still fails, which is the only property that makes this gate worth
// having.
const EXPECTED_FAILURES = new Map<string, Set<number>>([
  ['/api/proposals', new Set([403])],
  ['/api/integrations/quickbooks/status', new Set([501])],
  ['/api/integrations/shopify/status', new Set([501])],
]);

const AUTHENTICATED_ROUTES = [
  { path: '/dashboard', name: 'dashboard signed in' },
  { path: '/upload', name: 'upload' },
  { path: '/billing', name: 'billing' },
  { path: '/settings/datasets', name: 'settings datasets' },
  { path: '/settings/alerts', name: 'settings alerts' },
  { path: '/settings/integrations', name: 'settings integrations' },
  { path: '/settings/preferences', name: 'settings preferences' },
  { path: '/settings/email', name: 'settings email' },
  { path: '/settings/financials', name: 'settings financials' },
  { path: '/settings/invites', name: 'settings invites' },
];

test.describe('signed in', () => {
  let user: { userId: number; orgId: number };

  test.beforeAll(async () => {
    user = await ensureTestUser(TEST_USER);
  });

  for (const route of AUTHENTICATED_ROUTES) {
    test(`${route.name} makes no unexpected failing requests`, async ({ page, context, baseURL }) => {
      await authenticateAs(context, { ...user, role: 'owner', isAdmin: true });
      const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
      const failures: string[] = [];

      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin !== origin) return;
        if (response.status() < 400) return;
        if (EXPECTED_FAILURES.get(url.pathname)?.has(response.status())) return;
        failures.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
      });

      await page.goto(route.path);
      await page.locator('h1').first().waitFor({ timeout: 15_000 });
      await page.waitForLoadState('networkidle');

      expect(failures).toEqual([]);
    });
  }
});
