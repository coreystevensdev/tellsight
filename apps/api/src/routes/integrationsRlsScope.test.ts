import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// integration_connections carries a tenant-isolation policy, so every query
// against it needs a client that has org context: a withRlsContext transaction
// on the authenticated routes, dbAdmin on the public callbacks where no session
// exists to derive one from.
//
// Running one on the bare default client is not a clean failure. Postgres
// answers two ways depending on what the pooled connection last held: it raises
// `invalid input syntax for type integer` when app.current_org_id is genuinely
// unset, and silently matches nothing when the connection carries a stale org.
// So the bug presents as an intermittent 500 or as an empty result, and fifteen
// call sites sat like that across all three providers until a real OAuth flow
// hit a clean connection.
//
// The runtime tests mock the query module, so they cannot see which client was
// passed. This reads the source instead.

// Reading one file was the original mistake. Eighteen of the forty-five
// connection queries live in routes/integrations.ts; the other twenty-seven sit
// in the service tree, and those are the ones that produced
// "Connection 168 not found" about a connection that existed. A guard that only
// watches the route file would let that back in.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [full] : [];
  });
}

const CALLS = sourceFiles(ROOT).flatMap((file) =>
  [...readFileSync(file, 'utf8').matchAll(/integrationConnectionsQueries\.(\w+)\(([\s\S]*?)\);/g)].map((m) => ({
    file: file.slice(ROOT.length),
    fn: m[1]!,
    args: m[2]!,
  })),
);

describe('integration_connections queries are always org-scoped', () => {
  it('finds the call sites at all, so a rename cannot empty this test', () => {
    expect(CALLS.length).toBeGreaterThanOrEqual(40);
    // and they must come from more than the route file, or the scan silently
    // narrowed back to where it started
    expect(new Set(CALLS.map((c) => c.file)).size).toBeGreaterThan(5);
  });

  // Derived from what the scan finds, never a hardcoded list. The first version
  // of this guard named three functions and omitted getByIdAndProvider, which is
  // precisely the one whose seventeen unscoped reads caused the outage. A list
  // written by hand stays as wrong as the day it was written.
  it('passes a scoped client to every connection query, anywhere in the tree', () => {
    const unscoped = CALLS.filter((c) => !/\btx\b|\bdbAdmin\b/.test(c.args));
    expect(unscoped.map((c) => `${c.file} ${c.fn}`)).toEqual([]);
  });

  it('covers the query functions that actually exist, not a list someone typed', () => {
    const seen = new Set(CALLS.map((c) => c.fn));
    // These four are the ones that reach org-scoped rows. If a fifth appears the
    // assertion above already covers it; this only proves the scan sees the
    // read that broke, since a regex that silently stopped matching it would
    // otherwise leave every check vacuously green.
    for (const fn of ['getByIdAndProvider', 'getByOrgAndProvider', 'deleteByOrgAndProvider', 'upsert']) {
      expect(seen).toContain(fn);
    }
  });

  // The callbacks are public: the provider redirects the browser there with no
  // session, so withRlsContext has no orgId to take and dbAdmin is the only
  // option. Asserting this keeps someone from "fixing" them to match the
  // authenticated routes and breaking the flow again.
  it('uses dbAdmin for the callback writes, which have no session to scope by', () => {
    const upserts = CALLS.filter((c) => c.fn === 'upsert');
    expect(upserts).toHaveLength(3);
    for (const call of upserts) expect(call.args).toMatch(/dbAdmin/);
  });
});
