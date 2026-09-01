import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';

import { dbAdmin } from '../lib/db.js';

// rls.integration.test.ts proves the mechanism works, but only ever reads
// through `subscriptions`. Disabling row-level security on the other eighteen
// tables leaves all 64 integration tests green, so a migration containing
// `ALTER TABLE datasets DISABLE ROW LEVEL SECURITY` ships silently.
//
// The expected set is parsed from the migrations rather than hardcoded, so a
// table added with RLS is covered here the day it lands instead of whenever
// someone remembers to extend a list.

const MIGRATIONS = join(import.meta.dirname ?? __dirname, '../../drizzle/migrations');

// Not org-scoped, so there is no tenant predicate to write. Named explicitly
// because the useful failure is a *new* table appearing without a policy, and
// that only fails if the exceptions are a closed set rather than "whatever is
// currently unprotected".
const NOT_ORG_SCOPED = ['audit_logs', 'orgs', 'password_reset_tokens', 'users'];

function tablesWithRlsInMigrations(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const body = readFileSync(join(MIGRATIONS, file), 'utf-8');
    for (const [, table] of body.matchAll(
      /ALTER\s+TABLE\s+"?([a-z_]+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      found.add(table!);
    }
  }
  return [...found].sort();
}

const EXPECTED = tablesWithRlsInMigrations();

describe('row-level security, schema level', () => {
  // Without this the whole file passes if the regex stops matching.
  it('parsed a plausible set of tables from the migrations', () => {
    expect(EXPECTED.length).toBeGreaterThanOrEqual(19);
    expect(EXPECTED).toContain('data_rows');
    expect(EXPECTED).toContain('datasets');
    expect(EXPECTED).toContain('ai_summaries');
  });

  it('has row-level security enabled on every table the migrations enable it for', async () => {
    const rows = await dbAdmin.execute<{ relname: string; relrowsecurity: boolean }>(sql`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `);

    const live = new Map(rows.map((r) => [r.relname, r.relrowsecurity]));
    const missing = EXPECTED.filter((t) => live.get(t) !== true);

    expect(missing, `RLS disabled on: ${missing.join(', ')}`).toEqual([]);
  });

  // Enabled with no policy denies everything to a non-owner rather than leaking,
  // so this is a correctness check rather than a second security check. A
  // dropped policy is still a broken tenant boundary.
  it('has at least one policy on every table with row-level security', async () => {
    const rows = await dbAdmin.execute<{ tablename: string }>(sql`
      SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'
    `);

    const withPolicy = new Set(rows.map((r) => r.tablename));
    const bare = EXPECTED.filter((t) => !withPolicy.has(t));

    expect(bare, `no policy on: ${bare.join(', ')}`).toEqual([]);
  });

  // The exceptions are a closed set on purpose: a new org-scoped table landing
  // without RLS shows up here as an unexpected name, not as silence.
  it('has no unprotected public table beyond the ones deliberately outside RLS', async () => {
    const rows = await dbAdmin.execute<{ relname: string }>(sql`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    `);

    const unprotected = rows.map((r) => r.relname).sort();
    expect(unprotected).toEqual(NOT_ORG_SCOPED);
  });
});
