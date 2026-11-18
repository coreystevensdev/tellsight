import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Cache directory for one package's Vitest transformed modules.
 *
 * Vitest finds the workspace root and hands every concurrent Turbo task the
 * same directory, where startup cleanup races and fails with ENOTEMPTY, so the
 * package name separates them. The lockfile digest is the part that matters:
 * cached modules carry resolved dependency paths and Vitest does not invalidate
 * them when dependencies change, so a stale entry imports the old copy of a
 * package while `vi.mock` registers against the new one and never intercepts.
 * On 2026-11-17 that surfaced as "`headers` was called outside a request scope"
 * and read exactly like a Next behaviour change.
 *
 * Directories for superseded lockfiles are left to accumulate; deleting
 * siblings would reintroduce the ENOTEMPTY race, and a clean install reclaims
 * them.
 */
export function vitestCachePath(pkg: string, repoRoot = REPO_ROOT): string {
  return join(repoRoot, 'node_modules/.vitest-cache', `${pkg}-${lockDigest(repoRoot)}`);
}

function lockDigest(repoRoot: string): string {
  try {
    const lock = readFileSync(join(repoRoot, 'pnpm-lock.yaml'));
    return createHash('sha256').update(lock).digest('hex').slice(0, 12);
  } catch {
    // Throwing here would fail config load for every suite with an opaque
    // ENOENT; falling back just stops the cache keying on dependencies.
    return 'nolock';
  }
}
