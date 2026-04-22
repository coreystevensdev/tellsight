import { test, expect } from '@playwright/test';
import postgres from 'postgres';

import { authenticateAs } from './helpers/auth';
import {
  ensureTestUser,
  cleanupFixtureConnection,
  TEST_USER,
  SEED_ORG_ID,
} from './helpers/fixtures';
import { DATABASE_ADMIN_URL } from './helpers/config';

/**
 * Regression guard for Story 8.4's three-key SWR revalidation on save.
 *
 * The `saveCashBalance` handler in DashboardShell.tsx fires `Promise.all` of
 * three SWR mutations (financials, cashHistory, cashForecast) plus a
 * `router.refresh()` afterward. If any of the four settles in the wrong order
 * — or if any future refactor breaks the chain — the LockedInsightCard can
 * stick at visible even though cashOnHand is saved, or flicker through a
 * stale UI state.
 *
 * This test submits a balance via the "Enable Runway" card and asserts the
 * card reaches the hidden state cleanly (financials revalidation landed) and
 * the dashboard heading stays stable throughout (no error, no redirect).
 */

let adminUser: { userId: number; orgId: number };

test.beforeAll(async () => {
  adminUser = await ensureTestUser(TEST_USER);
});

test.afterAll(async () => {
  await cleanupFixtureConnection();
});

async function setupRunwayOnlyFixture() {
  const sql = postgres(DATABASE_ADMIN_URL, { max: 1 });
  try {
    // Goal: only the "Enable Runway" Locked Insight card should render. That
    // means cashOnHand must be absent AND monthlyFixedCosts must be SET (not
    // null), because the Break-Even card's gate is `monthlyFixedCosts == null`.
    //
    // Clearing monthlyFixedCosts would render BOTH cards and produce two
    // Save buttons — that's what the initial version of this fixture got
    // wrong. Setting fixedCosts to a non-null value hides Break-Even
    // unambiguously.
    await sql`
      UPDATE orgs
      SET business_profile = jsonb_set(
        COALESCE(business_profile, '{}'::jsonb) - 'cashOnHand' - 'cashAsOfDate',
        '{monthlyFixedCosts}',
        '10000'::jsonb
      )
      WHERE id = ${SEED_ORG_ID}
    `;
  } finally {
    await sql.end();
  }
}

test.describe('saveCashBalance revalidation', () => {
  test('Locked Insight card disappears after submitting a balance', async ({ browser }) => {
    // Default per-test timeout is 30s, but this test does: nav → fill → PUT →
    // three parallel SWR refetches → router.refresh → unmount. Each step is
    // fast individually; together they can exceed 30s on cold CI runners.
    test.setTimeout(60_000);

    await setupRunwayOnlyFixture();

    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...adminUser, role: 'owner', isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/dashboard');
    const heading = page.locator('#dashboard-heading');
    await heading.waitFor({ timeout: 15_000 });

    // Fixture guarantees only the Runway card renders, so a page-wide role
    // query is unambiguous. Break-Even card is hidden because monthlyFixedCosts
    // is set (the gate is `== null` on that field).
    const runwayHeading = page.getByRole('heading', { name: 'Enable Runway' });
    await expect(runwayHeading).toBeVisible({ timeout: 10_000 });
    await runwayHeading.scrollIntoViewIfNeeded();

    const input = page.getByLabel(/current cash balance/i);
    await input.fill('50000');

    // Confirm the button is enabled (valid state inside LockedInsightCard)
    // but don't click it. The button flips to `disabled` synchronously when
    // handleSubmit fires, and Playwright's click-retry mechanics race with
    // that state change unpredictably — earlier attempts with force:true
    // swallowed the actual DOM submit event. Pressing Enter on the input
    // dispatches a native `submit` on the form, which React's onSubmit
    // handler picks up cleanly. More realistic user behavior, too.
    const saveButton = page.getByRole('button', { name: /^save$/i });
    await expect(saveButton).toBeEnabled({ timeout: 5_000 });

    const [putResponse] = await Promise.all([
      page.waitForResponse(
        (resp) =>
          resp.url().includes('/api/org/financials') && resp.request().method() === 'PUT',
        { timeout: 10_000 },
      ),
      input.press('Enter'),
    ]);
    expect(putResponse.status()).toBe(200);

    // After the Promise.all resolves in saveCashBalance, financials revalidates
    // → needsCashBalance flips false → LockedInsightCard unmounts. If any SWR
    // key is left stale or the router.refresh races ahead, the card sticks at
    // visible and this assertion times out. Timeout widened to 30s because
    // three parallel SWR refetches + router.refresh take measurable time in CI.
    await expect(
      page.getByRole('heading', { name: 'Enable Runway' }),
    ).toBeHidden({ timeout: 30_000 });

    // Heading is a stable anchor across the dashboard RSC tree. If the page
    // redirected (auth loss, error boundary) or crashed during save, this
    // would fail — the negative signal we care about.
    await expect(heading).toBeVisible();

    // Negative assertion — no error toast / alert should be rendered. The
    // dashboard has a generic error boundary; if revalidation throws, an
    // alert with role="alert" surfaces somewhere in the tree.
    const errorAlert = page.getByRole('alert').filter({ hasText: /error|failed/i });
    await expect(errorAlert).toHaveCount(0);

    await ctx.close();
  });
});
