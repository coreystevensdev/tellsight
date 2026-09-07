import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 1,
  // Three spec files write to the seed org, and one of them strips cashOnHand
  // from the org the dashboard specs render. Playwright parallelises across
  // files, not just within them: CI was reporting "25 tests using 2 workers", so
  // that pair could interleave. Serial in CI costs wall clock and removes a
  // whole class of cross-file flake; locally the default still applies.
  workers: process.env.CI ? 1 : undefined,
  // A committed test.only would otherwise cut the run to one test and still
  // report green.
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
