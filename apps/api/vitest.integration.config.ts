import { defineConfig } from 'vitest/config';

// Separate project so the real-Postgres suite never runs under the default
// `pnpm test` (see vitest.config.ts's exclude), keeping the DB-less test-api
// CI job green with no service container.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/blockExternalNetwork.ts'],
    fileParallelism: false,
    include: ['src/**/*.integration.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=4096'],
      },
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      'shared/constants': new URL('../../packages/shared/src/constants/index.ts', import.meta.url).pathname,
      'shared/types': new URL('../../packages/shared/src/types/index.ts', import.meta.url).pathname,
      'shared/schemas': new URL('../../packages/shared/src/schemas/index.ts', import.meta.url).pathname,
      // apps/web aliases all five; these two were missing here, so anything
      // importing shared/agent or shared/formatting resolved through the package
      // exports to packages/shared/dist and the suite tested the last build.
      // Verified: gutting routeProposal in src and not rebuilding left
      // evaluateOrg.test.ts at 16/16 green while shared's own suite failed 7.
      // CI builds shared first so it was never wrong there, but the documented
      // dev loop, pnpm -C apps/api test, was.
      'shared/agent': new URL('../../packages/shared/src/agent/index.ts', import.meta.url).pathname,
      'shared/formatting': new URL('../../packages/shared/src/formatting/index.ts', import.meta.url).pathname,
    },
  },
});
