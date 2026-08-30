import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Every route reachable without a session or a signed token. proxy.ts guards
// /upload, /billing, /admin and /settings, and the token routes (/share,
// /invite, /mute, /unsubscribe) need a real token to render anything, so
// neither group can be scanned from a cold browser.
const PUBLIC_ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/login', name: 'login' },
  { path: '/signup', name: 'signup' },
  { path: '/forgot-password', name: 'forgot password' },
  { path: '/dashboard', name: 'dashboard' },
];

// axe returns the full DOM node for each violation, so asserting on the raw
// array buries the actual problem in a few hundred lines of diff.
const summarize = (violations: { id: string; impact?: string | null; nodes: unknown[] }[]) =>
  violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} node(s))`);

for (const route of PUBLIC_ROUTES) {
  test(`${route.name} passes axe with zero critical violations`, async ({ page }) => {
    await page.goto(route.path);
    await page.locator('h1').first().waitFor({ timeout: 15_000 });

    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');

    expect(summarize(critical)).toEqual([]);
  });
}
