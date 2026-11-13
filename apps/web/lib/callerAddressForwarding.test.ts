import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

// Express keys its IP rate limiters on req.ip, and every request it sees from
// here arrives on the same docker-bridge socket. A handler that forwards the
// caller address gets its own bucket; one that drops it shares a single bucket
// with the whole site, so one visitor can lock everyone out of /auth.
//
// Checked across the tree rather than per handler: the ones that were wrong had
// hand-rolled their fetch instead of using the bff-proxy helpers, and the next
// hand-rolled one will be wrong the same way.

const WEB = join(import.meta.dirname ?? __dirname, '..');

// next.config.ts names the upstream for Next's own fallback rewrite, which
// forwards the header itself, and lib/config.ts only declares the env var.
// Neither issues a fetch.
const NOT_A_FETCH = ['next.config.ts', 'lib/config.ts'];

function tsFiles(dir: string): string[] {
  if (dir.includes('node_modules') || dir.endsWith('/.next')) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('every upstream fetch carries the caller address', () => {
  const offenders = tsFiles(WEB)
    .filter((f) => !NOT_A_FETCH.some((skip) => f.endsWith(skip)))
    .filter((f) => {
      const body = readFileSync(f, 'utf-8');
      if (!body.includes('API_INTERNAL_URL')) return false;
      return !/forwardedFor|forwardedHeaders|'x-forwarded-for'/.test(body);
    })
    .map((f) => f.slice(WEB.length + 1));

  it('finds no handler that drops x-forwarded-for', () => {
    expect(offenders, `these reach the API without the caller address: ${offenders.join(', ')}`).toEqual([]);
  });

  // Without this the file passes if the scan stops finding anything at all.
  it('scanned a plausible number of upstream callers', () => {
    const callers = tsFiles(WEB).filter((f) => readFileSync(f, 'utf-8').includes('API_INTERNAL_URL'));
    expect(callers.length).toBeGreaterThanOrEqual(14);
  });
});
