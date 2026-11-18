import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { vitestCachePath } from './vitestCachePath.js';

const roots: string[] = [];

function repoWithLock(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), 'vitest-cache-path-'));
  roots.push(dir);
  writeFileSync(join(dir, 'pnpm-lock.yaml'), contents);
  return dir;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('vitestCachePath', () => {
  it('gives the same path for an unchanged lockfile, so the cache is reused', () => {
    const root = repoWithLock('lockfileVersion: 9.0\n');

    expect(vitestCachePath('web', root)).toBe(vitestCachePath('web', root));
  });

  // The reason the digest is in the path at all. A cached transformed module
  // holds resolved dependency paths, so reusing the directory across a bump is
  // what lets a mock and its subject load two different copies of one package.
  //
  // Rewrites the lockfile in one root rather than comparing two roots: separate
  // temp directories make the paths differ on their own, which let a constant
  // digest pass this assertion while defeating its entire purpose.
  it('gives a different path once the lockfile changes', () => {
    const root = repoWithLock('lockfileVersion: 9.0\nnext: 16.4.5\n');
    const before = vitestCachePath('web', root);

    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\nnext: 16.4.6\n');

    expect(vitestCachePath('web', root)).not.toBe(before);
  });

  // Keeps the original reason the path was overridden: concurrent Turbo tasks
  // sharing one directory race on startup cleanup and fail with ENOTEMPTY.
  it('keeps packages in separate directories', () => {
    const root = repoWithLock('lockfileVersion: 9.0\n');

    expect(vitestCachePath('web', root)).not.toBe(vitestCachePath('api', root));
  });

  it('still names the package when no lockfile is reachable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vitest-cache-path-'));
    roots.push(empty);

    expect(basename(vitestCachePath('api', empty))).toBe('api-nolock');
  });

  it('lands under node_modules so it stays ignored by git', () => {
    const root = repoWithLock('lockfileVersion: 9.0\n');

    expect(vitestCachePath('shared', root)).toContain(join('node_modules', '.vitest-cache'));
  });
});
