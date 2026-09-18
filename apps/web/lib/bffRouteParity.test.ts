import { describe, it, expect } from 'vitest';

// next.config sends /api/:path* to Express as a *fallback* rewrite, which runs
// only once nothing else has matched. So most paths need no route.ts at all.
// The trap is that adding one shadows the fallback for that path completely, and
// every method called on it then has to be exported there or the answer is 405
// rather than a passthrough. Adding a file makes a path less capable than adding
// nothing.
//
// GET /api/shares shipped exactly that way: app/api/shares/route.ts exported only
// POST. The e2e caught it because that call happens on page load. A DELETE behind
// a button would not have been caught by anything, which is what this is for.
//
// Everything runs inside the test rather than at module scope: under `vitest list`
// the jsdom environment resolves node:path and node:url to browser shims where
// join and fileURLToPath are undefined, and that collection failure surfaced only
// as a silent zero in the test-count badge.

describe('BFF route parity', () => {
  it('every apiClient path with a route file exports the method it is called with', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const WEB = process.cwd();
    const API_DIR = join(WEB, 'app/api');
    expect(statSync(API_DIR).isDirectory()).toBe(true);

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    };

    // `/shares/${id}` -> ['shares', '*'] so a [dynamic] directory can match it.
    const segments = (path: string) =>
      path.replace(/\$\{[^}]*\}/g, '*').split('?')[0]!.split('/').filter(Boolean);

    const findRouteFile = (parts: string[]): string | null => {
      let dir = API_DIR;
      for (const part of parts) {
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return null; }
        const isDir = (e: string) => statSync(join(dir, e)).isDirectory();
        const exact = entries.find((e) => e === part && isDir(e));
        const dynamic = entries.find((e) => /^\[.+\]$/.test(e) && isDir(e));
        const next = part === '*' ? dynamic : (exact ?? dynamic);
        if (!next) return null;
        dir = join(dir, next);
      }
      const file = join(dir, 'route.ts');
      try { statSync(file); return file; } catch { return null; }
    };

    const CALL = /apiClient\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1([^)]*)/g;
    const calls = walk(join(WEB, 'app'))
      .concat(walk(join(WEB, 'components')), walk(join(WEB, 'lib')))
      .flatMap((file) => {
        const src = readFileSync(file, 'utf8');
        return [...src.matchAll(CALL)].map((m) => ({
          file: file.slice(WEB.length),
          path: m[2]!,
          method: /method:\s*'(\w+)'/.exec(m[3] ?? '')?.[1] ?? 'GET',
        }));
      })
      .filter((c) => c.path.startsWith('/'));

    expect(calls.length).toBeGreaterThan(5);

    const broken = calls.flatMap((call) => {
      const routeFile = findRouteFile(segments(call.path));
      // No file is fine and common: the fallback rewrite carries it to Express.
      if (!routeFile) return [];

      const src = readFileSync(routeFile, 'utf8');
      const exported =
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${call.method}\\b`).test(src) ||
        new RegExp(`export\\s+const\\s+${call.method}\\b`).test(src);

      return exported
        ? []
        : [`${routeFile.slice(WEB.length)} shadows the fallback for ${call.method} ${call.path} (called from ${call.file}), so it answers 405`];
    });

    expect(broken).toEqual([]);
  });
});
