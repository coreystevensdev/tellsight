import { test, expect } from '@playwright/test';

import { authenticateAs } from './helpers/auth';
import { ensureTestUser, cleanupFixtureConnection, TEST_USER } from './helpers/fixtures';

// PRD targets. These are the product commitments, measured on real hardware.
const NFR = {
  dashboardLoad: 3_000, // NFR1
  csvUpload: 5_000, // NFR4, files under 10MB
  chartInteraction: 500, // NFR5, datasets up to 10k rows
  sharedCard: 2_000, // NFR6, no auth required
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

  // The share link is created authenticated, then measured signed out, because
  // NFR6 is specifically about the no-auth view a recipient gets. A separate
  // browser context is the cheapest way to guarantee no cookie leaks into it.
  //
  // generateShareLink refuses a dataset with no cached AI summary, and CI runs
  // with a dummy Claude key, so this skips rather than fails when seed data
  // shipped without one.
  test('NFR6: shared insight card loads within budget', async ({ browser }) => {
    const authed = await browser.newContext();
    await authenticateAs(authed, { ...testUser, role: 'owner', isAdmin: true });

    const listed = await authed.request.get('/api/datasets');
    const datasetId = listed.ok() ? (await listed.json())?.data?.[0]?.id : undefined;
    if (!datasetId) {
      test.skip(true, 'no dataset in the seed org to share');
      await authed.close();
      return;
    }

    const created = await authed.request.post('/api/shares', { data: { datasetId } });
    if (created.status() !== 201) {
      const body = await created.text();
      test.skip(true, `share not creatable: ${created.status()} ${body.slice(0, 120)}`);
      await authed.close();
      return;
    }
    const token = (await created.json()).data.token;
    await authed.close();

    const anon = await browser.newContext();
    const page = await anon.newPage();

    const started = Date.now();
    await page.goto(`/share/${token}`);
    await page.locator('article h1').waitFor({ timeout: 30_000 });
    const elapsed = Date.now() - started;

    reportTiming('NFR6 shared card', elapsed, NFR.sharedCard);
    expect(elapsed).toBeLessThan(budget(NFR.sharedCard));

    await anon.close();
  });

  // Runs against the public seeded dashboard, not an authenticated user:
  // DashboardShell only renders FilterBar when hasAnyData is true, and a fresh
  // test org has none, so the authenticated version had nothing to click.
  //
  // NFR5's target is qualified "for datasets up to 10,000 rows". Seed data is
  // smaller than that, so passing here is necessary but not sufficient.
  test('NFR5: date filter re-renders within budget', async ({ page }) => {
    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 30_000 });

    const dateFilter = page.getByRole('button', { name: 'Filter by date range' });
    if (!(await dateFilter.isVisible({ timeout: 15_000 }).catch(() => false))) {
      test.skip(true, 'dashboard has no data, so FilterBar is not rendered');
      return;
    }

    // Waits for the chart refetch the filter triggers, NOT networkidle.
    // networkidle is defined as 500ms of no requests, so using it here put a
    // 500ms floor under a 500ms target and made the NFR look breached by
    // roughly the size of its own budget.
    //
    // The listener is armed before the click because the response can land
    // before the click promise resolves. The initial load's own call to this
    // endpoint has already settled, since a chart had to be visible above.
    const refetched = page.waitForResponse(
      (r) => r.url().includes('/dashboard/charts') && r.status() === 200,
      { timeout: 15_000 },
    );

    const started = Date.now();
    await dateFilter.click();
    await page.getByRole('option', { name: 'Last 6 months' }).click();
    await refetched;
    const elapsed = Date.now() - started;

    reportTiming('NFR5 date filter', elapsed, NFR.chartInteraction);
    expect(elapsed).toBeLessThan(budget(NFR.chartInteraction));
  });
});
