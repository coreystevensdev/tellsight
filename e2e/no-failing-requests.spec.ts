import { test, expect } from '@playwright/test';

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
