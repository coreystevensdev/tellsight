import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/blockExternalNetwork.ts'],
    fileParallelism: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // rls.integration.test.ts hits a real Postgres role and runs under its
    // own project (vitest.integration.config.ts) with a CI job that provides
    // the service container; the default run has no DB to connect to.
    exclude: [...configDefaults.exclude, 'src/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Ratchet measured 2026-08-30: 88% lines, 89.7% branches, 81.2% functions.
      // Only bites locally, since CI runs these under continue-on-error.
      thresholds: {
        statements: 85,
        branches: 87,
        functions: 78,
        lines: 85,
      },
    },
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
