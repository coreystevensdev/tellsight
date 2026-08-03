import { defineConfig } from 'vitest/config';

// The repo's package-level vitest configs scope include to each app's `src/`, so a
// test living under scripts/ has no runner. This config covers exactly the
// deterministic eval scorers. Run it with:
//   pnpm -C apps/api exec vitest run -c ../../scripts/vitest.config.ts
// (apps/api owns the vitest + zod binaries this actually runs with; root also
// carries its own vitest + zod so `tsc -p scripts/tsconfig.json` has something
// to resolve their type declarations against, since scripts/ has no package.json.)
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
