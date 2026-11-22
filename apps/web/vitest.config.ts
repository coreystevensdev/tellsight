import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

import { vitestCachePath } from '../../packages/shared/src/test/vitestCachePath.js';

export default defineConfig({
  plugins: [react()],
  test: {
    fsModuleCachePath: vitestCachePath('web'),
    environment: 'jsdom',
    // Vitest defaults to 5000ms and the slowest test here measured 3390ms quiet,
    // 3849ms with a second copy of this suite running. Files run in parallel (no
    // fileParallelism: false, unlike the api config), so that contention is the
    // normal case rather than an accident.
    //
    // The specific trap: UploadDropzone.test.tsx:502 waits on a redirect with
    // `waitFor(..., { timeout: 5000 })`, the same budget as the test itself. At the
    // default the test is killed before that waitFor can report what it was waiting
    // for, so a slow run looks like a bare timeout rather than a failed redirect.
    // 15s matches both api configs and leaves the inner wait room to fail usefully.
    testTimeout: 15_000,
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
