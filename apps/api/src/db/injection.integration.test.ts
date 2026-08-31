import { eq, sql } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { orgs } from './schema.js';
import { dbAdmin } from '../lib/db.js';

// ADR criterion 5.4 asks for injection and XSS coverage. Drizzle parameterises
// every query, so the claim under test is not "we sanitise input" but "input is
// never concatenated into SQL", and the only way to prove that is against a real
// server. A mocked client would pass these no matter what the code did.
//
// Runs under vitest.integration.config.ts, same real-Postgres CI job as the RLS
// suite.

const PAYLOADS = [
  { name: 'classic drop', value: "'; DROP TABLE orgs; --" },
  { name: 'tautology', value: "' OR '1'='1" },
  { name: 'union select', value: "' UNION SELECT NULL, current_user, NULL, NULL, NULL --" },
  { name: 'stacked update', value: "'; UPDATE orgs SET name = 'pwned'; --" },
  { name: 'newline comment terminator', value: 'admin\n-- ' },
  { name: 'xss script tag', value: '<script>alert("xss")</script>' },
  { name: 'xss img onerror', value: '<img src=x onerror=alert(1)>' },
];

const created: number[] = [];

afterAll(async () => {
  if (created.length) {
    await dbAdmin.delete(orgs).where(sql`id = ANY(${created})`);
  }
});

describe('injection payloads are data, not SQL', () => {
  it.each(PAYLOADS)('stores $name verbatim and leaves the schema intact', async ({ value }) => {
    const slug = `inj-${Math.abs(hash(value))}`;

    const [row] = await dbAdmin.insert(orgs).values({ name: value, slug }).returning();
    expect(row).toBeDefined();
    created.push(row!.id);

    // Round-trips byte for byte. If any of it had been executed or stripped, the
    // stored value would differ from what went in.
    const [read] = await dbAdmin.select().from(orgs).where(eq(orgs.id, row!.id));
    expect(read!.name).toBe(value);

    // The table the payloads try to drop or rewrite is still there, and no other
    // row was touched by the stacked UPDATE attempt.
    const rows = await dbAdmin.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM orgs WHERE name = 'pwned'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('treats a payload as a literal in a WHERE clause rather than a predicate', async () => {
    const tautology = "' OR '1'='1";
    const [row] = await dbAdmin
      .insert(orgs)
      .values({ name: 'injection-where-probe', slug: `inj-where-${Date.now()}` })
      .returning();
    created.push(row!.id);

    const total = await dbAdmin.select().from(orgs);
    const matches = await dbAdmin.select().from(orgs).where(eq(orgs.name, tautology));

    // The point is the comparison, not the count. Interpreted, `' OR '1'='1`
    // makes the predicate always true and returns every org. Parameterised, it
    // is just a string, so it matches only rows literally named that, which the
    // payload suite above happens to have created exactly one of.
    expect(matches.length).toBeLessThan(total.length);
    expect(matches.every((m) => m.name === tautology)).toBe(true);
  });

  it('keeps the orgs table present after every payload has been inserted', async () => {
    const rows = await dbAdmin.execute<{ exists: boolean }>(
      sql`SELECT to_regclass('public.orgs') IS NOT NULL AS exists`,
    );
    expect(rows[0]?.exists).toBe(true);
  });
});

// Small stable hash so slugs are deterministic per payload and the unique
// constraint does not fight repeated local runs.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
