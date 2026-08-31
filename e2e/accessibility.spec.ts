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

// Gates on critical and serious, with nothing excluded.
//
// color-contrast was briefly excluded here: it failed on 12 nodes, all of them
// palette rather than markup. The tokens were darkened instead (#0D9488 to
// #0B7C72, success to #2F7D37), so the exclusion is gone and the rule gates like
// any other. Re-add an exclusion only as a last resort, and never silently:
// a disabled rule looks identical to a passing one from the outside.
const GATED_IMPACTS = new Set(['critical', 'serious']);

for (const route of PUBLIC_ROUTES) {
  test(`${route.name} passes axe with zero critical or serious violations`, async ({ page }) => {
    await page.goto(route.path);
    await page.locator('h1').first().waitFor({ timeout: 15_000 });

    const results = await new AxeBuilder({ page }).analyze();
    const gated = results.violations.filter((v) => GATED_IMPACTS.has(v.impact ?? ''));

    expect(summarize(gated)).toEqual([]);
  });
}

// NFR24 landmark half, on every public route rather than just the dashboard.
// A page without <main> gives a screen reader user no way past the chrome, and
// four of these five had none until the (auth) layout and the landing page were
// given one.
for (const route of PUBLIC_ROUTES) {
  test(`${route.name} exposes a main landmark`, async ({ page }) => {
    await page.goto(route.path);
    await page.locator('h1').first().waitFor({ timeout: 15_000 });

    await expect(page.locator('main')).toHaveCount(1);
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

// NFR24: semantic elements rather than div-for-everything. The dashboard carries
// the full set, so it is where the whole list is worth asserting.
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
