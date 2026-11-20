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

function callsTo(queryModule: string) {
  const pattern = new RegExp(`${queryModule}\\.(\\w+)\\(([\\s\\S]*?)\\);`, 'g');
  return sourceFiles(ROOT).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map((m) => ({
      file: file.slice(ROOT.length),
      fn: m[1]!,
      args: m[2]!,
    })),
  );
}

const CALLS = callsTo('integrationConnectionsQueries');

// datasets carries the same tenant policy, and an unscoped read of it is worse
// than an unscoped write: RLS returns no rows rather than raising, so the
// symptom is a field that looks like missing data. A unit test cannot see this
// at all, because it mocks the query module and a mock does not care which
// client it was handed. All 36 call sites already pass one; this keeps it that
// way.
const DATASET_CALLS = callsTo('datasetsQueries');

// orgs and cash_balance_snapshots carry the same policy, and this module is
// written from a worker as well as a route. The Plaid sync called
// updateOrgFinancials with no client, so it ran as app_user: the snapshot
// insert was refused with 42501 and the whole transaction rolled back, which
// the sync's non-fatal catch turned into a warning. Every sync reported success
// while the balance it existed to record was never written. The unit test could
// not see it, because it mocks the query module and a mock does not care which
// client it was handed.
const FINANCIALS_CALLS = callsTo('orgFinancialsQueries');

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

  it('scopes every org financials query, which a worker writes as well as a route', () => {
    expect(FINANCIALS_CALLS.length).toBeGreaterThanOrEqual(5);
    // More than one file, or the scan narrowed to the routes and would miss the
    // worker call that actually broke.
    expect(new Set(FINANCIALS_CALLS.map((c) => c.file)).size).toBeGreaterThan(1);

    const unscoped = FINANCIALS_CALLS.filter((c) => !/\btx\b|\bdbAdmin\b|\bclient\b/.test(c.args));
    expect(unscoped.map((c) => `${c.file} ${c.fn}`)).toEqual([]);
  });

  it('sees the write that broke, so the scan cannot be vacuously green', () => {
    expect(new Set(FINANCIALS_CALLS.map((c) => c.fn))).toContain('updateOrgFinancials');
  });

  it('scopes every datasets query too, where an unscoped read returns nothing instead of failing', () => {
    expect(DATASET_CALLS.length).toBeGreaterThanOrEqual(30);
    const unscoped = DATASET_CALLS.filter((c) => !/\btx\b|\bdbAdmin\b|\bclient\b/.test(c.args));
    expect(unscoped.map((c) => `${c.file} ${c.fn}`)).toEqual([]);
  });

  // The callbacks are public: the provider redirects the browser there with no
  // session, so withRlsContext has no orgId to take and dbAdmin is the only
  // option. Asserting this keeps someone from "fixing" them to match the
  // authenticated routes and breaking the flow again.
  //
  // Split by file rather than counted. This asserted exactly three upserts, all
  // dbAdmin, which was true while every provider connected through a redirect.
  // Plaid does not: Link is client-side and its token exchange arrives on the
  // owner's own session, so that one upsert has a context to scope by and must
  // use it. A count would have forced the choice between bumping a number and
  // making a session route write with dbAdmin, which is the wrong direction.
  const isCallback = (file: string) => file.includes('integrationCallbacks');

  it('uses dbAdmin for the callback writes, which have no session to scope by', () => {
    const upserts = CALLS.filter((c) => c.fn === 'upsert' && isCallback(c.file));
    expect(upserts.length).toBeGreaterThanOrEqual(3);
    for (const call of upserts) expect(call.args).toMatch(/dbAdmin/);
  });

  // The other direction, which only became possible once an upsert ran on a
  // session: a write that could be scoped must not reach for dbAdmin and skip
  // the tenant policy entirely.
  it('scopes connection writes that do have a session, rather than using dbAdmin', () => {
    const sessionUpserts = CALLS.filter((c) => c.fn === 'upsert' && !isCallback(c.file));
    expect(sessionUpserts.length).toBeGreaterThan(0);
    for (const call of sessionUpserts) {
      expect(call.args).toMatch(/\btx\b/);
      expect(call.args).not.toMatch(/dbAdmin/);
    }
  });
});
