import { eq, inArray, sql } from 'drizzle-orm';
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

// Explicit slugs rather than a hash of the payload: slug is unique, and a hash
// collision would fail as a constraint violation that looks nothing like the
// thing being tested.
const PAYLOADS = [
  { slug: 'inj-drop', value: "'; DROP TABLE orgs; --" },
  { slug: 'inj-tautology', value: "' OR '1'='1" },
  { slug: 'inj-union', value: "' UNION SELECT NULL, current_user, NULL, NULL, NULL --" },
  { slug: 'inj-stacked', value: "'; UPDATE orgs SET name = 'pwned'; --" },
  { slug: 'inj-comment', value: 'admin\n-- ' },
  { slug: 'inj-xss-script', value: '<script>alert("xss")</script>' },
  { slug: 'inj-xss-img', value: '<img src=x onerror=alert(1)>' },
];

const TAUTOLOGY = "' OR '1'='1";
const created: number[] = [];

afterAll(async () => {
  // inArray, not a raw ANY() bind: drizzle builds the parameter list itself, and
  // a teardown that throws fails the whole file even when every test passed.
  if (created.length) {
    await dbAdmin.delete(orgs).where(inArray(orgs.id, created));
  }
});

describe('injection payloads are data, not SQL', () => {
  it.each(PAYLOADS)('stores $slug verbatim and leaves the schema intact', async ({ slug, value }) => {
    const [row] = await dbAdmin.insert(orgs).values({ name: value, slug }).returning();
    expect(row).toBeDefined();
    created.push(row!.id);

    // Round-trips byte for byte. If any of it had been executed or stripped, the
    // stored value would differ from what went in.
    const [read] = await dbAdmin.select().from(orgs).where(eq(orgs.id, row!.id));
    expect(read!.name).toBe(value);

    // The stacked-UPDATE payload tries to rename every org. Nothing should carry
    // the name it would have written.
    const pwned = await dbAdmin.select().from(orgs).where(eq(orgs.name, 'pwned'));
    expect(pwned).toHaveLength(0);
  });

  it('treats a tautology as a literal rather than a predicate', async () => {
    const total = await dbAdmin.select().from(orgs);
    const matches = await dbAdmin.select().from(orgs).where(eq(orgs.name, TAUTOLOGY));

    // The comparison is the point, not the count. Interpreted, `' OR '1'='1`
    // makes the predicate always true and returns every org. Parameterised, it
    // is just a string, so it matches only rows literally named that. The
    // payload suite above created exactly one such row.
    expect(total.length).toBeGreaterThan(matches.length);
    expect(matches.every((m) => m.name === TAUTOLOGY)).toBe(true);
  });

  it('still has an orgs table after every payload has been inserted', async () => {
    const rows = await dbAdmin.execute<{ present: boolean }>(
      sql`SELECT to_regclass('public.orgs') IS NOT NULL AS present`,
    );
    expect(rows[0]?.present).toBe(true);
  });
});
