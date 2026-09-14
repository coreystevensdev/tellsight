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
// array buries the actual problem in a few hundred lines of diff. The first
// version of this went too far the other way and printed only a rule name and a
// count, which told you something broke and not what: a CI failure here could
// not be acted on without re-running the scan by hand. Each node's target
// selector is a few characters and is the one thing you actually need.
const summarize = (
  violations: { id: string; impact?: string | null; nodes: { target?: unknown[] }[] }[],
) =>
  violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.nodes.map((n) => (n.target ?? []).join(' ')).join(' | ')}`,
  );

// Gates on critical and serious, with nothing excluded.
//
// color-contrast was briefly excluded here: it failed on 12 nodes, all of them
// palette rather than markup. The tokens were darkened instead (#0D9488 to
// #0B7C72, success to #2F7D37), so the exclusion is gone and the rule gates like
// any other. Re-add an exclusion only as a last resort, and never silently:
// a disabled rule looks identical to a passing one from the outside.
const GATED_IMPACTS = new Set(['critical', 'serious']);

// Until now this ran light mode at the default viewport and nothing else, so the
// dark palette had never been scanned once. That is the half of the product
// where contrast is hardest to get right and the only half whose tokens nobody
// had checked. Mobile is here for the same reason: target size and overlap are
// viewport-dependent rules that a 1280px scan cannot reach.
// Charts mount on viewport intersection and the AI disclaimer sits below the
// fold, so a scan of the initial viewport never reaches either. That is not
// hypothetical: the disclaimer scored 2.56 against AA on the AI surface, in both
// themes, on three separate screens including the public share page, and this
// gate could not see it because it never scrolled.
//
// Walks to the bottom and stays there. Scrolling back up would be tidier and
// would risk unmounting whatever only exists while intersecting; axe reads the
// DOM rather than the viewport, so leaving the page at the bottom costs nothing.
async function revealLazyContent(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const scroller = document.getElementById('main-content') ?? document.scrollingElement ?? document.body;
    for (let i = 0; i < 25; i += 1) {
      const before = scroller.scrollTop;
      scroller.scrollTop += 600;
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (scroller.scrollTop === before) break;
    }
  });
  await page.waitForTimeout(400);
}

const THEMES = [
  { name: 'light', colorScheme: 'light' as const },
  { name: 'dark', colorScheme: 'dark' as const },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    for (const route of PUBLIC_ROUTES) {
      test(`${route.name} passes axe in ${theme.name} on ${viewport.name}`, async ({ page }) => {
        await page.emulateMedia({ colorScheme: theme.colorScheme });
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(route.path);
        await page.locator('h1').first().waitFor({ timeout: 15_000 });

        // Assert the theme took before scanning. next-themes applies .dark after
        // hydration, so a scan that starts too early, or an emulateMedia that
        // stops working after an upgrade, would scan light twice and report two
        // passes. A vacuous green here is worse than no test: it would say the
        // dark palette is clear when nothing had looked at it.
        const isDark = theme.name === 'dark';
        await expect
          .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), {
            timeout: 10_000,
          })
          .toBe(isDark);

        await revealLazyContent(page);

        const results = await new AxeBuilder({ page }).analyze();
        const gated = results.violations.filter((v) => GATED_IMPACTS.has(v.impact ?? ''));

        expect(summarize(gated)).toEqual([]);
      });
    }
  }
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

  // Wait for the link itself before tabbing. Pressing Tab before hydration has
  // wired it up lands focus somewhere else and the test flakes under load.
  const skipLink = page.locator('a[href^="#"]').first();
  await skipLink.waitFor({ state: 'attached', timeout: 15_000 });
  await page.keyboard.press('Tab');

  const href = await page.evaluate(
    () => (document.activeElement as HTMLAnchorElement)?.getAttribute('href') ?? null,
  );

  expect(href, 'first tab stop is not a link').toBeTruthy();
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
