import { test, expect } from '@playwright/test';

import { authenticateAs } from './helpers/auth';
import { ensureTestUser, cleanupFixtureConnection, TEST_USER } from './helpers/fixtures';

// PRD targets. These are the product commitments, measured on real hardware.
const NFR = {
  dashboardLoad: 3_000, // NFR1
  csvUpload: 5_000, // NFR4, files under 10MB
  chartInteraction: 500, // NFR5, datasets up to 10k rows
};

// A shared GitHub runner is not the hardware the PRD targets, and a perf test
// that flakes gets deleted rather than fixed. So the assertion runs against a
// slack multiple of the target, which still catches an order-of-magnitude
// regression, while the real number is always logged. Read the logged numbers,
// not the assertion, when you want to know whether the NFR actually holds.
const SLACK = process.env.CI ? 4 : 1.5;
const budget = (target: number) => Math.round(target * SLACK);

function reportTiming(label: string, elapsed: number, target: number) {
  const verdict = elapsed <= target ? 'within' : 'OVER';
  console.log(`[perf] ${label}: ${elapsed}ms (${verdict} NFR target ${target}ms, CI budget ${budget(target)}ms)`);
}

// 10k rows is the count NFR5 names and lands around 400KB, well under NFR4's
// 10MB bound. Generated rather than committed so the fixture is not in git.
// Note this only exercises NFR4: POST /api/datasets is the preview step, so
// these rows are parsed but never confirmed into the dashboard NFR5 measures.
function buildCsv(rows: number): Buffer {
  const categories = ['Revenue', 'Payroll', 'Rent', 'Marketing', 'Software'];
  const lines = ['date,amount,category'];
  for (let i = 0; i < rows; i++) {
    const month = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 28) + 1).padStart(2, '0');
    const amount = (100 + (i % 900)).toFixed(2);
    lines.push(`2025-${month}-${day},${amount},${categories[i % categories.length]}`);
  }
  return Buffer.from(lines.join('\n'), 'utf-8');
}

let testUser: { userId: number; orgId: number };

test.beforeAll(async () => {
  testUser = await ensureTestUser(TEST_USER);
});

test.afterAll(async () => {
  await cleanupFixtureConnection();
});

test.describe.configure({ mode: 'serial' });

test.describe('Performance NFRs', () => {
  test('NFR1: dashboard renders within budget', async ({ page }) => {
    const started = Date.now();
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 30_000 });
    const elapsed = Date.now() - started;

    reportTiming('NFR1 dashboard load', elapsed, NFR.dashboardLoad);
    expect(elapsed).toBeLessThan(budget(NFR.dashboardLoad));
  });

  test('NFR4: 10k-row CSV upload completes within budget', async ({ browser }) => {
    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...testUser, role: 'owner', isAdmin: true });

    const csv = buildCsv(10_000);
    const started = Date.now();
    const response = await ctx.request.post('/api/datasets', {
      multipart: {
        file: { name: 'perf-10k.csv', mimeType: 'text/csv', buffer: csv },
      },
      timeout: 60_000,
    });
    const elapsed = Date.now() - started;

    if (response.status() === 429) {
      test.skip(true, 'upload rate limited in CI');
      await ctx.close();
      return;
    }
    expect(response.status()).toBe(200);

    reportTiming(`NFR4 CSV upload (${Math.round(csv.byteLength / 1024)}KB)`, elapsed, NFR.csvUpload);
    expect(elapsed).toBeLessThan(budget(NFR.csvUpload));

    await ctx.close();
  });

  // NFR5's target is qualified "for datasets up to 10,000 rows". This measures
  // whatever the seeded dashboard holds, which is smaller, so a pass here is
  // necessary but not sufficient for the NFR as written.
  test('NFR5: date filter re-renders within budget', async ({ browser }) => {
    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...testUser, role: 'owner', isAdmin: true });
    const page = await ctx.newPage();

    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 30_000 });
    await page.locator('canvas, svg, [class*="recharts"]').first().waitFor({ timeout: 15_000 });

    // Clock starts on the click, not the navigation, so this measures the
    // interaction rather than the page load behind it.
    const started = Date.now();
    await page.getByRole('button', { name: 'Filter by date range' }).click();
    await page.getByRole('option', { name: 'Last 6 months' }).click();
    await page.waitForLoadState('networkidle');
    const elapsed = Date.now() - started;

    reportTiming('NFR5 date filter', elapsed, NFR.chartInteraction);
    expect(elapsed).toBeLessThan(budget(NFR.chartInteraction));

    await ctx.close();
  });
});
