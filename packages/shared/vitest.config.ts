import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test/blockExternalNetwork.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Ratchet measured 2026-10-29: 89.88% statements, 87.93% branches,
      // 72.91% functions and 91.77% lines. Keep these just below the measured
      // baseline and raise them as coverage climbs.
      thresholds: {
        statements: 89,
        branches: 87,
        functions: 72,
        lines: 91,
      },
    },
  },
});
