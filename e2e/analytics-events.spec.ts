import { test, expect } from '@playwright/test';

import { authenticateAs } from './helpers/auth';
import { queryAnalyticsEvents, waitForEvent, cleanupAdminConnection } from './helpers/admin';
import { ensureTestUser, cleanupFixtureConnection, TEST_USER, SAMPLE_CSV } from './helpers/fixtures';

let adminUser: { userId: number; orgId: number };

test.beforeAll(async () => {
  adminUser = await ensureTestUser(TEST_USER);
});

test.afterAll(async () => {
  await cleanupAdminConnection();
  await cleanupFixtureConnection();
});

test.describe.configure({ mode: 'serial' });

test.describe('Analytics Event Verification (FR40)', () => {
  test('dashboard.viewed fires when authenticated user visits dashboard', async ({ browser }) => {
    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...adminUser, role: 'owner', isAdmin: true });
    const page = await ctx.newPage();
    const since = new Date().toISOString();

    await page.goto('/dashboard');
    await page.locator('#dashboard-heading').waitFor({ timeout: 15_000 });

    const event = await waitForEvent(ctx.request, 'dashboard.viewed', since);

    // waitForEvent already polls 2s plus ten 1s attempts. Nothing after twelve
    // seconds means the write is not coming, which is the thing under test, so
    // this asserts rather than warning. The old `if (event)` passed with every
    // trackEvent call deleted.
    expect(event, 'dashboard.viewed never persisted').not.toBeNull();
    expect(event!.org_id).toBe(adminUser.orgId);
    expect(event!.user_id).toBe(adminUser.userId);

    await ctx.close();
  });

  test('dataset.uploaded fires when CSV is uploaded via API', async ({ browser }) => {
    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...adminUser, role: 'owner', isAdmin: true });

    const since = new Date().toISOString();

    const csvBlob = Buffer.from(SAMPLE_CSV, 'utf-8');
    const response = await ctx.request.post('/api/datasets', {
      multipart: {
        file: {
          name: 'test-upload.csv',
          mimeType: 'text/csv',
          buffer: csvBlob,
        },
      },
    });

    if (response.status() === 429) {
      console.warn('Upload rate limited in CI, skipping event assertion');
      await ctx.close();
      return;
    }
    expect(response.status()).toBe(200);

    const event = await waitForEvent(ctx.request, 'dataset.uploaded', since);

    expect(event, 'dataset.uploaded never persisted').not.toBeNull();
    expect(event!.event_name).toBe('dataset.uploaded');
    expect(event!.org_id).toBe(adminUser.orgId);

    await ctx.close();
  });

  test('event shape validation via admin API', async ({ browser }) => {
    const ctx = await browser.newContext();
    await authenticateAs(ctx, { ...adminUser, role: 'owner', isAdmin: true });

    // give prior fire-and-forget events a moment to persist
    await new Promise((r) => setTimeout(r, 2_000));

    let events;
    try {
      events = await queryAnalyticsEvents(ctx.request, {
        orgId: adminUser.orgId,
        limit: 50,
      });
    } catch (err) {
      // queryAnalyticsEvents throws two different things: a genuine rate-limit
      // exhaustion, and any non-ok response. Catching both as "rate limited"
      // means a 500 from the admin endpoint skips this test silently, which is
      // how /admin/email-compliance stayed broken in production for a while.
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('rate limited')) {
        await ctx.close();
        throw err;
      }
      console.warn('Admin analytics query rate limited, skipping shape validation');
      await ctx.close();
      return;
    }

    // Was a warn-and-return. An empty list here is not a tolerable state: this
    // test loads the dashboard first, so at least that event must exist, and
    // with zero rows the shape loop below iterates nothing and the test passes
    // having checked nothing.
    expect(events.length, 'no analytics events to validate the shape of').toBeGreaterThan(0);

    for (const event of events) {
      expect(event).toHaveProperty('eventName');
      expect(event).toHaveProperty('orgName');
      expect(event).toHaveProperty('createdAt');
      expect(typeof event.eventName).toBe('string');
    }

    await ctx.close();
  });
});
