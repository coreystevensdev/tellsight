import { test, expect } from '@playwright/test';
import { authenticateAs } from './helpers/auth';
import { ensureTestUser, TEST_USER } from './helpers/fixtures';

// A page wider than the phone it is read on scrolls sideways, and the left edge
// is what disappears: the heading reads "grations" and every line starts
// mid-sentence. Nothing caught it. accessibility.spec does run a 390px viewport,
// but only over the public routes; its authenticated block varies theme and
// never width. So /settings/integrations had never been looked at narrow, and
// axe has no rule for overflow in any case.
//
// What broke it: each connector card put the text and the buttons in one flex
// row and gave the buttons shrink-0, while the text column kept the flex default
// of min-width:auto and so refused to shrink. Two buttons plus "Connected to
// 9341457586501237" cannot fit 375px, so the row ran to x=429.
const MOBILE = { width: 375, height: 812 };

const SLACK = 1;

// scrollWidth is NOT the measurement. Chromium clips an over-wide child and
// reports the viewport width back: the broken integrations page read
// scrollWidth 375 of clientWidth 375 while its button row sat at x=429. iOS
// Safari does not clip the same way, which is how a page can be swipeable on a
// phone while every headless check calls it clean. Element rects catch it.
async function overflow(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    const limit = el.clientWidth;
    const past = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.right > limit + 1)
      .sort((a, b) => b.box.right - a.box.right);

    return {
      limit,
      widest: past.length ? Math.round(past[0]!.box.right) : limit,
      offenders: past.slice(0, 4).map(({ node, box }) => {
        const cls = (node.className || '').toString().split(' ').slice(0, 3).join('.');
        return `${node.tagName.toLowerCase()}${cls ? '.' + cls : ''} right=${Math.round(box.right)}`;
      }),
    };
  });
}

function assertFits(result: { limit: number; widest: number; offenders: string[] }) {
  expect(
    result.widest,
    `${result.widest - result.limit}px past the ${result.limit}px viewport: ${result.offenders.join(' | ') || 'none'}`,
  ).toBeLessThanOrEqual(result.limit + SLACK);
}

const PUBLIC_ROUTES = [
  { path: '/', name: 'landing' },
  { path: '/login', name: 'login' },
  { path: '/signup', name: 'signup' },
  { path: '/dashboard', name: 'dashboard' },
];

const AUTHENTICATED_ROUTES = [
  { path: '/settings/integrations', name: 'settings integrations' },
  { path: '/settings/datasets', name: 'settings datasets' },
  { path: '/settings/alerts', name: 'settings alerts' },
  { path: '/settings/invites', name: 'settings invites' },
  { path: '/billing', name: 'billing' },
  { path: '/upload', name: 'upload' },
];

test.describe(`nothing reaches past ${MOBILE.width}px`, () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.name} fits the viewport`, async ({ page }) => {
      await page.setViewportSize(MOBILE);
      await page.goto(route.path);
      await page.locator('h1').first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(500);

      assertFits(await overflow(page));
    });
  }

  test.describe('authenticated', () => {
    let user: { userId: number; orgId: number };

    test.beforeAll(async () => {
      user = await ensureTestUser(TEST_USER);
    });

    for (const route of AUTHENTICATED_ROUTES) {
      test(`${route.name} fits the viewport`, async ({ page, context }) => {
        await authenticateAs(context, { ...user, role: 'owner', isAdmin: true });
        await page.setViewportSize(MOBILE);
        await page.goto(route.path);
        await page.locator('h1').first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(500);

        assertFits(await overflow(page));
      });
    }
  });
});
