import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// withRlsContext(orgId, isAdmin, fn) is what scopes a query to one tenant.
// Passing a literal true for isAdmin bypasses the RLS policy for that
// transaction, and a route doing so would read every org's rows.
//
// Twelve route test files mock withRlsContext; two assert what it was called
// with. Adding that assertion to the other ten would cover today's routes and
// nothing written afterwards, so this checks the call sites directly instead:
// the second argument has to be an expression, never a hardcoded boolean.
//
// This is deliberately not a lint rule. It travels with the suite, it fails in
// the same place as everything else, and nobody has to remember to install it.

const SRC = join(import.meta.dirname ?? __dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

// Splits on top-level commas so a nested call in an argument does not confuse
// the boundary.
function firstTwoArgs(source: string, openIdx: number): string[] {
  let depth = 0;
  let current = '';
  const args: string[] = [];
  for (let i = openIdx; i < source.length && args.length < 2; i++) {
    const ch = source[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0) break;
    if (depth === 1 && ch === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }
    if (!(depth === 1 && i === openIdx)) current += ch;
  }
  return args;
}

describe('withRlsContext call sites', () => {
  const callSites = tsFiles(SRC)
    .filter((f) => !f.endsWith(join('lib', 'rls.ts')))
    .flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const sites: { file: string; isAdminArg: string }[] = [];
      let idx = source.indexOf('withRlsContext(');
      while (idx !== -1) {
        const open = idx + 'withRlsContext'.length;
        const [, isAdminArg] = firstTwoArgs(source, open);
        if (isAdminArg !== undefined) {
          sites.push({ file: file.slice(SRC.length + 1), isAdminArg });
        }
        idx = source.indexOf('withRlsContext(', idx + 1);
      }
      return sites;
    });

  // If this drops to zero the checks below all pass vacuously, which is the
  // failure mode a guard like this actually has.
  it('finds the call sites it is meant to be checking', () => {
    expect(callSites.length).toBeGreaterThan(10);
  });

  it.each(callSites)('$file does not hardcode isAdmin ($isAdminArg)', ({ isAdminArg }) => {
    expect(isAdminArg).not.toBe('true');
    expect(isAdminArg).not.toBe('false');
  });
});
