import { defineConfig } from 'vitest/config';

import { vitestCachePath } from '../packages/shared/src/test/vitestCachePath.js';

// The repo's package-level vitest configs scope include to each app's `src/`, so a
// test living under scripts/ has no runner. This config covers everything here:
// the deterministic eval scorers under eval-fixtures/, and the guards that read
// repo files rather than code, deploy-via-ssm, connectorEnvReachesDeploy and the
// readme-sync checks. Run it with:
//   pnpm -C apps/api exec vitest run -c ../../scripts/vitest.config.ts
// (apps/api owns the vitest + zod binaries this actually runs with; root also
// carries its own vitest + zod so `tsc -p scripts/tsconfig.json` has something
// to resolve their type declarations against, since scripts/ has no package.json.)
export default defineConfig({
  test: {
    // Keyed on the lockfile digest like the other three configs. Without it this
    // suite took vitest's default and wrote into `node_modules/.vitest-cache`
    // itself, the parent of the keyed directories, where nothing invalidated it
    // on a dependency change. That is the phantom-failure class #372 fixed
    // everywhere else: a cached transform keeps the old dependency's resolved
    // path, so `vi.mock` and its subject end up on two copies of one package and
    // the mock silently does nothing.
    fsModuleCachePath: vitestCachePath('scripts'),
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
