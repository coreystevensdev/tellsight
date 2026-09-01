import { test, expect } from '@playwright/test';

import { authenticateAs } from './helpers/auth';
import { ensureTestUser, cleanupFixtureConnection, getSeedDatasetId, TEST_USER } from './helpers/fixtures';

// PRD targets. These are the product commitments, measured on real hardware.
const NFR = {
  dashboardLoad: 3_000, // NFR1
  csvUpload: 5_000, // NFR4, files under 10MB
  chartInteraction: 500, // NFR5, datasets up to 10k rows
  sharedCard: 2_000, // NFR6, no auth required
};

// A shared GitHub runner is not the hardware the PRD targets, and a perf test
// that flakes gets deleted rather than fixed, so the hard assertion still runs
// against a slack multiple rather than the target itself.
//
// Was 4x. Traceability made the cost of that concrete: NFR1's target is 3000ms
// and the build only failed above 12000ms, so a fourfold regression shipped
// green. 2x keeps a wide margin over what CI actually measures (NFR1 709ms,
// NFR4 97ms, NFR5 239ms, NFR6 309ms) while halving the blind spot. If NFR5
// starts flaking, raise this back rather than deleting the test: the warning
// below is the part that catches drift, and it does not depend on the multiple.
const SLACK = process.env.CI ? 2 : 1.5;

// Measured on the CI runner, 2026-08-30. A multiple of the PRD target is the
// wrong shape once real performance is orders of magnitude better than the
// commitment: NFR4 runs at 97ms against a 5000ms target, so the build only
// failed above 10000ms and a hundredfold regression shipped green.
const OBSERVED_CI = {
  dashboardLoad: 709,
  csvUpload: 97,
  chartInteraction: 239,
  sharedCard: 309,
} satisfies Record<keyof typeof NFR, number>;

// 3x what this hardware actually does absorbs shared-runner noise while still
// catching a real regression. The floor stops the smallest measurement from
// producing a budget too tight to survive a noisy run. Taking the min with the
// PRD ceiling means this can only tighten a budget, never loosen one, so the
// product commitment stays the outer bound.
const OBSERVED_MULTIPLE = 3;
const BUDGET_FLOOR_MS = 500;

function budget(key: keyof typeof NFR): number {
  const prdCeiling = Math.round(NFR[key] * SLACK);
  const fromObserved = Math.max(OBSERVED_CI[key] * OBSERVED_MULTIPLE, BUDGET_FLOOR_MS);
  return Math.min(prdCeiling, Math.round(fromObserved));
}

function reportTiming(label: string, key: keyof typeof NFR, elapsed: number) {
  const target = NFR[key];
  const over = elapsed > target;
  const verdict = over ? 'OVER' : 'within';
  console.log(`[perf] ${label}: ${elapsed}ms (${verdict} NFR target ${target}ms, CI budget ${budget(key)}ms)`);

  if (!over) return;

  // Between the target and the budget the build passes, and telling someone to
  // go read the log is the same as telling them nothing. A ::warning:: lands on
  // the run summary and the changed file, and the annotation carries it into the
  // HTML report, so exceeding the actual NFR is visible without failing on
  // runner noise.
  const detail = `${elapsed}ms against a ${target}ms target (build fails above ${budget(key)}ms)`;
  test.info().annotations.push({ type: 'nfr-exceeded', description: `${label}: ${detail}` });
  if (process.env.CI) {
    console.log(`::warning title=NFR target exceeded::${label} took ${detail}`);
  }
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

    reportTiming('NFR1 dashboard load', 'dashboardLoad', elapsed);
    expect(elapsed).toBeLessThan(budget('dashboardLoad'));
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

    // A 429 here is the dashboardCompute/upload tier being wrong for a single
    // 400KB post, not an environment quirk. Skipping on it meant a misconfigured
    // limiter produced a green run.
    expect(
      response.status(),
      `upload returned ${response.status()}; a 429 means the rate-limiter tier is misconfigured`,
    ).toBe(200);

    reportTiming(`NFR4 CSV upload (${Math.round(csv.byteLength / 1024)}KB)`, 'csvUpload', elapsed);
    expect(elapsed).toBeLessThan(budget('csvUpload'));

    // POST /api/datasets is parse plus validate plus hash with no row written.
    // Timing only that left the insert path unmeasured, so a confirm handler
    // rewritten to insert 10,000 rows one statement at a time was invisible
    // here. No observed baseline for this yet, so it runs against the PRD
    // ceiling; tighten it the same way once CI has reported a few numbers.
    const previewToken = (await response.json()).data?.previewToken;
    expect(previewToken, 'preview response carried no previewToken').toBeTruthy();

    const confirmStarted = Date.now();
    const confirmed = await ctx.request.post('/api/datasets/confirm', {
      multipart: {
        file: { name: 'perf-10k.csv', mimeType: 'text/csv', buffer: csv },
        previewToken,
      },
      timeout: 60_000,
    });
    const confirmElapsed = Date.now() - confirmStarted;

    expect(confirmed.status(), await confirmed.text().catch(() => '')).toBe(200);
    console.log(`[perf] NFR4 confirm (10k rows persisted): ${confirmElapsed}ms`);
    expect(confirmElapsed).toBeLessThan(Math.round(NFR.csvUpload * SLACK));

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

    // Read the id straight from the DB rather than /datasets/manage, which
    // filters isSeedData = false. A fresh CI org has only the seed dataset, so
    // the API list is legitimately empty and this used to skip every run.
    const datasetId = await getSeedDatasetId();
    expect(datasetId, 'no seed dataset in the database, so seeding is broken').toBeTruthy();

    const created = await authed.request.post('/api/shares', { data: { datasetId } });
    // seed.ts catches a failed live Claude call and inserts FALLBACK_SEED_SUMMARY,
    // which is exactly what CI's dummy key produces, so there is always a cached
    // summary to share. Skipping on its absence hid a broken seed.
    expect(
      created.status(),
      `share creation failed: ${created.status()} ${(await created.text()).slice(0, 200)}`,
    ).toBe(201);

    const token = (await created.json()).data.token;
    await authed.close();

    const anon = await browser.newContext();
    const page = await anon.newPage();

    const started = Date.now();
    await page.goto(`/share/${token}`);
    await page.locator('article h1').waitFor({ timeout: 30_000 });
    const elapsed = Date.now() - started;

    reportTiming('NFR6 shared card', 'sharedCard', elapsed);
    expect(elapsed).toBeLessThan(budget('sharedCard'));

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
    await expect(
      dateFilter,
      'FilterBar is absent on the seeded public dashboard, so either seeding or hasAnyData is broken',
    ).toBeVisible({ timeout: 15_000 });

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

    reportTiming('NFR5 date filter', 'chartInteraction', elapsed);
    expect(elapsed).toBeLessThan(budget('chartInteraction'));
  });
});
