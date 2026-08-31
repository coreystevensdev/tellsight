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

// Gate raised from critical-only to critical + serious, minus one rule.
//
// color-contrast is excluded because it currently fails on 12 nodes, and every
// one is the product's own palette rather than a markup mistake: white on the
// teal accent #0d9488 at 12px scores 3.74 against the 4.5 AA needs, the success
// green #3a9742 on #fcfcfc scores 3.6, and teal on the light teal surface
// #e9f7f5 scores 3.4. Fixing those means darkening tokens in the locked colour
// anchor, which is a design decision and not one to make inside an a11y test.
// Excluding it by name keeps every other serious rule gating, instead of the
// whole severity staying unwatched to hide one known problem.
const GATED_IMPACTS = new Set(['critical', 'serious']);
const KNOWN_FAILING_RULES = ['color-contrast'];

for (const route of PUBLIC_ROUTES) {
  test(`${route.name} passes axe with zero critical or serious violations`, async ({ page }) => {
    await page.goto(route.path);
    await page.locator('h1').first().waitFor({ timeout: 15_000 });

    const results = await new AxeBuilder({ page }).disableRules(KNOWN_FAILING_RULES).analyze();
    const gated = results.violations.filter((v) => GATED_IMPACTS.has(v.impact ?? ''));

    expect(summarize(gated)).toEqual([]);
  });
}

// NFR25: interactive elements are keyboard-navigable.
test('dashboard is traversable by keyboard', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

  const seen: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'BODY';
        return el.tagName.toLowerCase();
      }),
    );
  }

  // Focus has to actually leave body, reach real controls, and keep moving.
  // A single element repeated 25 times is the signature of a focus trap, which
  // is worse for a keyboard user than having no focus styles at all.
  expect(seen.filter((t) => t === 'BODY')).toHaveLength(0);
  expect(seen.some((t) => t === 'a' || t === 'button')).toBe(true);
  expect(new Set(seen).size).toBeGreaterThan(1);
});

// The skip link is the first thing a keyboard user hits, and it is useless if
// its target does not exist.
test('skip link targets a real element', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

  await page.keyboard.press('Tab');
  const href = await page.evaluate(() => (document.activeElement as HTMLAnchorElement)?.getAttribute('href'));

  expect(href).toBeTruthy();
  expect(href!.startsWith('#')).toBe(true);
  await expect(page.locator(href!)).toHaveCount(1);
});

// NFR24: semantic elements rather than div-for-everything. Asserted on the
// dashboard, the one route that carries the full set. The auth routes and the
// landing page have h1/section/button but no <main>, which is a real gap
// recorded in the traceability matrix rather than asserted away here.
test('dashboard uses semantic landmarks', async ({ page }) => {
  await page.goto('/dashboard');
  await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

  for (const el of ['header', 'nav', 'main', 'section', 'h1']) {
    await expect(page.locator(el).first()).toBeAttached();
  }

  // "not div-for-everything": the controls have to be real buttons, since a
  // div with a click handler is invisible to keyboard and screen reader users.
  expect(await page.locator('button').count()).toBeGreaterThan(5);
});
