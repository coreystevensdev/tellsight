import { defineConfig } from 'vitest/config';

// Separate project so the real-Postgres suite never runs under the default
// `pnpm test` (see vitest.config.ts's exclude), keeping the DB-less test-api
// CI job green with no service container.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
    },
  },
});
