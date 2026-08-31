import { test, expect } from '@playwright/test';

import { getSeedDatasetId, cleanupFixtureConnection } from './helpers/fixtures';

test.describe('Dashboard', () => {
  test('loads with seed data and renders key elements', async ({ page }) => {
    await page.goto('/dashboard');

    // org name heading renders, proves RSC pipeline + API worked
    const heading = page.locator('#dashboard-heading');
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // recharts-surface, not a bare svg. The old selector was
    // 'canvas, svg, [class*="recharts"]', which also matches ChartSkeleton's
    // own <svg> and the header logo, so it passed while every chart 500ed and
    // sat as a skeleton forever. recharts only emits this class once it has
    // actually drawn.
    const charts = page.locator('svg.recharts-surface');
    await expect(charts.first()).toBeVisible({ timeout: 15_000 });
  });

  test('AI summary card renders when seed summary exists', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    // The skip is gated on whether a summary exists in the database, not on
    // whether one is visible on the page. Skipping because the element under
    // test is missing means a completely broken AI summary skips green, which
    // is the failure mode this test exists to catch.
    const datasetId = await getSeedDatasetId();
    test.skip(datasetId === null, 'No seed dataset in this environment');

    const cached = await page.request.get(`/api/ai-summaries/${datasetId}/latest`);
    test.skip(
      cached.status() === 404,
      'No seed AI summary stored, expected when CLAUDE_API_KEY is the CI dummy',
    );

    // Past this point a summary exists, so anything missing is a real failure.
    const summaryRegion = page.locator('[aria-label="AI business summary"]');
    await expect(summaryRegion).toBeVisible({ timeout: 15_000 });
    // The disclaimer, not "Powered by AI". That string does not exist in the app
    // and has not for some time; it survives only in a stale _explained.md. It
    // was also this test's skip condition, so the test skipped silently on every
    // run instead of failing, which is how it went unnoticed.
    //
    // The disclaimer is the right thing to assert anyway: the project's legal
    // posture requires one on every AI summary.
    await expect(page.getByText(/not financial advice/i)).toBeVisible();

    const text = await summaryRegion.innerText();
    expect(text.length).toBeGreaterThanOrEqual(50);
  });
});

test.afterAll(async () => {
  await cleanupFixtureConnection();
});
