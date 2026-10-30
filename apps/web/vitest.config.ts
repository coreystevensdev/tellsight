import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    // Keep concurrent Turbo tasks from racing over Vitest's workspace-level
    // transformed-module cache during startup cleanup.
    fsModuleCachePath: '../../node_modules/.vitest-cache/web',
    environment: 'jsdom',
    setupFiles: ['../../packages/shared/src/test/blockExternalNetwork.ts', './test/setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      exclude: ['node_modules', '.next', 'test/**', '**/*.config.*', '**/*.d.ts'],
      // Ratchet, not target. Measured 2026-10-29: 89.23% statements,
      // 80.06% branches, 85.95% functions and 91.55% lines. Keep these just
      // below the measured baseline and raise them as coverage climbs.
      thresholds: {
        statements: 89,
        branches: 79,
        functions: 85,
        lines: 91,
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      'shared/constants': fileURLToPath(
        new URL('../../packages/shared/src/constants/index.ts', import.meta.url),
      ),
      'shared/types': fileURLToPath(
        new URL('../../packages/shared/src/types/index.ts', import.meta.url),
      ),
      'shared/schemas': fileURLToPath(
        new URL('../../packages/shared/src/schemas/index.ts', import.meta.url),
      ),
      'shared/agent': fileURLToPath(
        new URL('../../packages/shared/src/agent/index.ts', import.meta.url),
      ),
      'shared/formatting': fileURLToPath(
        new URL('../../packages/shared/src/formatting/index.ts', import.meta.url),
      ),
      'shared/benchmarks': fileURLToPath(
        new URL('../../packages/shared/src/benchmarks/index.ts', import.meta.url),
      ),
    },
  },
});
