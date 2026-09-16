import { readFileSync } from 'node:fs';
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

const SOURCE = readFileSync(fileURLToPath(new URL('./integrations.ts', import.meta.url)), 'utf8');

const CALLS = [
  ...SOURCE.matchAll(
    /integrationConnectionsQueries\.(\w+)\(([\s\S]*?)\);/g,
  ),
].map((m) => ({ fn: m[1]!, args: m[2]! }));

describe('integration_connections queries are always org-scoped', () => {
  it('finds the call sites at all, so a rename cannot empty this test', () => {
    expect(CALLS.length).toBeGreaterThanOrEqual(15);
  });

  it.each([
    'getByOrgAndProvider',
    'deleteByOrgAndProvider',
    'upsert',
  ])('passes a scoped client to every %s call', (fn) => {
    const calls = CALLS.filter((c) => c.fn === fn);
    expect(calls.length).toBeGreaterThan(0);

    const unscoped = calls.filter((c) => !/\btx\b|\bdbAdmin\b/.test(c.args));
    expect(unscoped).toEqual([]);
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
