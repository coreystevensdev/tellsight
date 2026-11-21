import { defineConfig } from 'vitest/config';

import { vitestCachePath } from '../../packages/shared/src/test/vitestCachePath.js';

// Separate project so the real-Postgres suite never runs under the default
// `pnpm test` (see vitest.config.ts's exclude), keeping the DB-less test-api
// CI job green with no service container.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../packages/shared/src/test/blockExternalNetwork.ts'],
    fileParallelism: false,
    include: ['src/**/*.integration.test.ts'],
    // Default is 10s. A cold vite cache spends about 6.5s just resolving the
    // import graph before any hook body runs, which left beforeAll/afterAll
    // timing out on the first run after a cache clear.
    hookTimeout: 30_000,
    // 18 tests timed out at vitest's 5000ms default on 2026-11-21 and did not
    // reproduce in three attempts after. Nominal cost is nowhere near it: the
    // slowest test measures 1591ms warm and 448ms cold, so this is the same
    // load variance #413 covered for the unit suite, not a slow test. Cold
    // cache and a freshly migrated DB were both tested as causes and neither
    // reproduces it.
    testTimeout: 15_000,
    // This config was the one #407 missed. Without a key it wrote into
    // node_modules/.vitest-cache itself, the parent of the four keyed
    // directories, where 379 bare entries had collected and nothing
    // invalidated them on a dependency change. Its own package name, not
    // 'api', so the two api configs never race on cleanup.
    fsModuleCachePath: vitestCachePath('api-integration'),
    pool: 'forks',
    // vitest 4 removed poolOptions; the pool settings are top-level now.
    execArgv: ['--max-old-space-size=4096'],
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      'shared/constants': new URL('../../packages/shared/src/constants/index.ts', import.meta.url)
        .pathname,
      'shared/types': new URL('../../packages/shared/src/types/index.ts', import.meta.url).pathname,
      'shared/schemas': new URL('../../packages/shared/src/schemas/index.ts', import.meta.url)
        .pathname,
      // apps/web aliases all five; these two were missing here, so anything
      // importing shared/agent or shared/formatting resolved through the package
      // exports to packages/shared/dist and the suite tested the last build.
      // Verified: gutting routeProposal in src and not rebuilding left
      // evaluateOrg.test.ts at 16/16 green while shared's own suite failed 7.
      // CI builds shared first so it was never wrong there, but the documented
      // dev loop, pnpm -C apps/api test, was.
      'shared/agent': new URL('../../packages/shared/src/agent/index.ts', import.meta.url).pathname,
      'shared/formatting': new URL('../../packages/shared/src/formatting/index.ts', import.meta.url)
        .pathname,
    },
  },
});
