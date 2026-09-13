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

// FR24, amended 2026-09-13: the AI summary follows the charts it describes.
//
// It previously required the summary above the fold and before the charts. The
// reason it read that way was the Marcus acquisition journey, and that rationale
// turned out to live somewhere else: a shared link renders /share/[token], whose
// SharedInsightCard is heading, summary prose, disclaimer and CTA with no charts
// at all. Dashboard ordering never touched that path.
//
// The cost of the change is real and is not asserted here: on a phone the
// interpretation now sits below six charts, so a returning owner scrolls to
// reach it.
test.describe('FR24 summary follows the charts', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the AI summary comes after the charts', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    const summary = page.locator('[aria-label="AI business summary"]').first();
    await summary.waitFor({ timeout: 15_000 });

    expect(await summary.boundingBox()).not.toBeNull();

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

    // DOM order rather than pixel order. null rather than a boolean when either
    // node is missing, so a broken chart endpoint fails loudly instead of
    // quietly satisfying the comparison.
    const chartsPrecedeSummary = await page.evaluate(() => {
      const s = document.querySelector('[aria-label="AI business summary"]');
      const chart = document.querySelector('svg.recharts-surface');
      if (!s || !chart) return null;
      return Boolean(chart.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING);
    });

    expect(chartsPrecedeSummary).toBe(true);
  });
});
