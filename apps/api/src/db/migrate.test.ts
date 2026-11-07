import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// DW-240: both scripts used to fall back from DATABASE_ADMIN_URL to
// DATABASE_URL. That connects as app_user, which cannot bypass RLS, so a data
// migration's UPDATE matched zero rows, raised nothing, and got recorded as
// applied. These spawn the real scripts because the check runs at module load
// and calls process.exit, which is not reachable from an import.
//
// DATABASE_URL is deliberately present and pointed at a port nothing listens
// on. If the fallback ever comes back, the script gets past the env check and
// fails trying to connect, so asserting the exact message is what separates
// "refused up front" from "failed later for an unrelated reason".
const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const UNREACHABLE = 'postgresql://app_user:app@127.0.0.1:1/analytics';

function runWithoutAdminUrl(script: string) {
  // Typed as ProcessEnv so the spread keeps its index signature and the delete
  // below type-checks.
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: UNREACHABLE };
  delete env.DATABASE_ADMIN_URL;

  return spawnSync('npx', ['tsx', `src/db/${script}`], {
    cwd: API_ROOT,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

// Each case spawns `npx tsx`, measured at 3.3 to 4.1 seconds unloaded, against
// vitest's 5000ms default. So these only ever passed by about a second, and
// failed the first time the full suite was busy. The 60s on spawnSync bounds the
// child and said nothing about the test's own budget, which is the gap.
const SPAWN_BUDGET_MS = 30_000;

describe('migration and seed scripts require the admin database URL', () => {
  it('migrate.ts refuses to run on DATABASE_URL alone', { timeout: SPAWN_BUDGET_MS }, () => {
    const result = runWithoutAdminUrl('migrate.ts');

    expect(result.stderr).toContain('DATABASE_ADMIN_URL is required for migrations');
    expect(result.status).toBe(1);
    // Nothing should have been attempted against the database.
    expect(result.stdout).not.toContain('Running database migrations');
  });

  it('seed.ts refuses to run on DATABASE_URL alone', { timeout: SPAWN_BUDGET_MS }, () => {
    const result = runWithoutAdminUrl('seed.ts');

    expect(result.stderr).toContain('DATABASE_ADMIN_URL is required for seeding');
    expect(result.status).toBe(1);
  });
});
