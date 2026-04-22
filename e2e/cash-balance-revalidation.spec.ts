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

async function clearCashOnHand() {
  const sql = postgres(DATABASE_ADMIN_URL, { max: 1 });
  try {
    // Strip cash-related fields from the seed org's businessProfile JSONB.
    // Leaves other onboarding fields intact (businessType, teamSize, etc.).
    await sql`
      UPDATE orgs
      SET business_profile = COALESCE(business_profile, '{}'::jsonb)
        - 'cashOnHand'
        - 'cashAsOfDate'
      WHERE id = ${SEED_ORG_ID}
    `;
  } finally {
    await sql.end();
  }
}

test.describe('saveCashBalance revalidation', () => {
  test('Locked Insight card disappears after submitting a balance', async ({ browser }) => {
    await clearCashOnHand();

    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...adminUser, role: 'owner', isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/dashboard');
    const heading = page.locator('#dashboard-heading');
    await heading.waitFor({ timeout: 15_000 });

    // Card renders because cashOnHand is null after the fixture wipe.
    const enableRunway = page.getByRole('heading', { name: 'Enable Runway' });
    await expect(enableRunway).toBeVisible({ timeout: 10_000 });

    // Submit a balance. Input id is generated via useId; target by label.
    const input = page.getByLabel(/current cash balance/i);
    await input.fill('50000');
    await page.getByRole('button', { name: /^save$/i }).click();

    // After the Promise.all resolves, financials revalidates → needsCashBalance
    // flips false → LockedInsightCard unmounts. If any SWR key is left stale
    // or the router.refresh races ahead, the card sticks at visible and this
    // assertion times out.
    await expect(enableRunway).toBeHidden({ timeout: 15_000 });

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
