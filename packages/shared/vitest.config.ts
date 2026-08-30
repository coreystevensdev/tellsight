import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // Mostly schemas and constants, so line coverage reads low here and
      // branch coverage is the honest signal.
      // Ratchet measured 2026-08-30: 51.3% lines, 76.6% branches, 45.8% functions.
      thresholds: {
        statements: 48,
        branches: 73,
        functions: 42,
        lines: 48,
      },
    },
  },
});
