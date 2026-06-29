import { defineConfig } from 'vitest/config';

// The repo's package-level vitest configs scope include to each app's `src/`, so a
// test living under scripts/ has no runner. This config covers exactly the
// deterministic eval scorers. Run it with:
//   pnpm -C apps/api exec vitest run -c ../../scripts/vitest.config.ts
// (apps/api owns the vitest + zod binaries; tsx/vitest resolve them from there.)
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['eval-fixtures/**/*.test.ts'],
    environment: 'node',
  },
});
