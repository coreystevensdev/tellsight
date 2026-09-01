import { test, expect } from '@playwright/test';

import { authenticateAs } from './helpers/auth';
import { ensureTestUser, cleanupFixtureConnection, TEST_USER, SEED_ORG_ID } from './helpers/fixtures';

test.afterAll(async () => {
  await cleanupFixtureConnection();
});

// FR12: upload flow state is preserved so a user can correct a bad file and
// re-upload without losing their session.
//
// Driven through the API with a real session cookie rather than the upload UI.
// The requirement is about the session surviving a rejected upload, and a
// file-picker interaction adds fragility without testing more of that claim.
test.describe('FR12 correct and re-upload', () => {
  const BAD = 'date,revenue,expenses\n2026-01-15,12000,8000\n';
  const GOOD = 'date,amount,category\n2026-01-15,12000,Revenue\n2026-02-15,15000,Revenue\n';

  test('a rejected upload does not cost the user their session', async ({ page, context }) => {
    const { userId } = await ensureTestUser(TEST_USER);
    await authenticateAs(context, {
      userId,
      orgId: SEED_ORG_ID,
      role: TEST_USER.role,
      isAdmin: TEST_USER.isAdmin,
    });
    await page.goto('/dashboard');

    const upload = (csv: string, name: string) =>
      page.request.post('/api/datasets', {
        multipart: { file: { name, mimeType: 'text/csv', buffer: Buffer.from(csv) } },
      });

    const rejected = await upload(BAD, 'wrong-columns.csv');
    expect(rejected.status()).toBe(400);
    const err = await rejected.json();
    // The error has to name the columns, or "correct and re-upload" is guesswork.
    expect(JSON.stringify(err)).toContain('amount');

    // The same session, immediately after, on a corrected file.
    const accepted = await upload(GOOD, 'corrected.csv');
    expect(accepted.status()).toBe(200);
    const body = await accepted.json();
    expect(body.data.previewToken).toBeTruthy();

    // And still authenticated for anything else, which is the actual claim:
    // a 400 on the file must not read as a 401 on the user.
    const list = await page.request.get('/api/datasets/manage');
    expect(list.status()).toBe(200);
  });
});

// FR24: on mobile viewports the AI summary is above the fold, before charts and
// filters.
//
// Two of the three clauses are asserted here. The summary does not come before
// the filter bar, which renders above the dashboard section on every viewport;
// that gap is recorded in the traceability matrix rather than reinterpreted to
// make a test pass.
test.describe('FR24 mobile summary placement', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the AI summary starts above the fold and precedes the charts', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    const summary = page.locator('[aria-label="AI business summary"]').first();
    await summary.waitFor({ timeout: 15_000 });

    const box = await summary.boundingBox();
    expect(box).not.toBeNull();

    // Above the fold means the card begins inside the first screen. Asserting
    // the whole card fits would be wrong: it is long-form prose and is meant to
    // be scrolled.
    const viewportHeight = page.viewportSize()!.height;
    expect(box!.y).toBeLessThan(viewportHeight);

    // Charts mount on viewport intersection, so on a phone-sized screen none
    // exist until you scroll. Scroll to bring them in rather than tolerating
    // their absence: this originally read
    // `if (summaryPrecedesCharts !== null)` with a comment calling a missing
    // chart "nothing to assert", which is the same
    // skip-when-the-target-is-missing shape dashboard.spec.ts was fixed to drop.
    // Break the chart endpoint and the ordering check went quiet.
    //
    // The above-the-fold measurement above is taken before this scroll, which is
    // the only order that makes it mean anything.
    // #main-content is the scroll container, not the window: dashboard/layout.tsx
    // gives it overflow-y-auto, so document.body.scrollHeight equals the
    // viewport height and window.scrollTo does nothing at all.
    await page.evaluate(() => {
      const scroller = document.getElementById('main-content');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.locator('svg.recharts-surface').first().waitFor({ timeout: 30_000 });

    // DOM order rather than pixel order, because a chart below the fold still
    // counts as coming after the summary.
    const summaryPrecedesCharts = await page.evaluate(() => {
      const s = document.querySelector('[aria-label="AI business summary"]');
      const chart = document.querySelector('svg.recharts-surface');
      if (!s || !chart) return null;
      return Boolean(s.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING);
    });

    expect(summaryPrecedesCharts).toBe(true);
  });
});
