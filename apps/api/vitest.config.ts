import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
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
    },
  },
});
