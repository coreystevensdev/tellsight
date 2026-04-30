import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Dashboard', () => {
  test('loads with seed data and renders key elements', async ({ page }) => {
    await page.goto('/dashboard');

    // org name heading renders, proves RSC pipeline + API worked
    const heading = page.locator('#dashboard-heading');
    await expect(heading).toBeVisible({ timeout: 15_000 });

    // at least one chart container is present (lazy-loaded)
    const charts = page.locator('canvas, svg, [class*="recharts"]');
    await expect(charts.first()).toBeVisible({ timeout: 10_000 });
  });

  test('AI summary card renders when seed summary exists', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    // seed summary may not exist in CI (dummy Claude key)
    const aiFooter = page.getByText('Powered by AI');
    const hasAiSummary = await aiFooter.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!hasAiSummary) {
      test.skip(true, 'No seed AI summary, Claude API key is a CI dummy');
      return;
    }

    const summaryRegion = page.locator('[aria-label="AI business summary"]');
    const text = await summaryRegion.innerText();
    expect(text.length).toBeGreaterThanOrEqual(50);
  });

  test('passes accessibility checks with zero critical violations', async ({ page }) => {
    await page.goto('/dashboard');

    // wait for main content to load before scanning
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    const results = await new AxeBuilder({ page }).analyze();
    const critical = results.violations.filter((v) => v.impact === 'critical');

    expect(critical).toEqual([]);
  });
});
