import { eq, inArray, sql } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dataRows, datasets, orgs } from './schema.js';
import { createDataset, updateDatasetName } from './queries/datasets.js';
import { insertBatch } from './queries/dataRows.js';
import { dbAdmin } from '../lib/db.js';

// ADR criterion 5.4 asks for injection and XSS coverage. Drizzle parameterises
// every query, so the claim under test is not "we sanitise input" but "user
// input is never concatenated into SQL", and proving that needs a real server.
//
// This drives the payloads through the application's own query helpers rather
// than calling dbAdmin.insert directly. An earlier version did the latter, which
// only demonstrated that Drizzle parameterises: every route could have been
// rewritten to concatenate raw SQL and it would still have passed. These paths
// carry the rawest user input in the product, CSV cell contents and a dataset
// name taken from an uploaded filename.
//
// Runs under vitest.integration.config.ts, same real-Postgres CI job as the RLS
// suite.

const PAYLOADS = [
  { slug: 'inj-drop', value: "'; DROP TABLE data_rows; --" },
  { slug: 'inj-tautology', value: "' OR '1'='1" },
  { slug: 'inj-union', value: "' UNION SELECT NULL, current_user, NULL --" },
  { slug: 'inj-stacked', value: "'; UPDATE datasets SET name = 'pwned'; --" },
  { slug: 'inj-comment', value: 'admin\n-- ' },
  { slug: 'inj-xss-script', value: '<script>alert("xss")</script>' },
  { slug: 'inj-xss-img', value: '<img src=x onerror=alert(1)>' },
];

const createdOrgs: number[] = [];

afterAll(async () => {
  if (createdOrgs.length) {
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
});

async function freshOrg(slug: string): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `injection ${slug}`, slug: `inj-${slug}-${process.pid}` })
    .returning();
  createdOrgs.push(org!.id);
  return org!.id;
}

describe('injection payloads through the application query layer', () => {
  it.each(PAYLOADS)('$slug survives a CSV row round trip as data', async ({ slug, value }) => {
    const orgId = await freshOrg(slug);
    const dataset = await createDataset(orgId, { name: `${slug}.csv` }, dbAdmin);

    // category and label are CSV cell contents, straight from an uploaded file.
    await insertBatch(
      orgId,
      dataset!.id,
      [{ category: value, label: value, date: new Date('2026-01-15'), amount: '100.00' }],
      dbAdmin,
    );

    const [row] = await dbAdmin.select().from(dataRows).where(eq(dataRows.datasetId, dataset!.id));

    // Byte for byte. Anything executed or stripped would differ from the input.
    expect(row!.category).toBe(value);
    expect(row!.label).toBe(value);

    // The stacked-UPDATE payload tries to rename every dataset.
    const pwned = await dbAdmin.select().from(datasets).where(eq(datasets.name, 'pwned'));
    expect(pwned).toHaveLength(0);
  });

  it('stores a payload as a dataset name through updateDatasetName', async () => {
    const orgId = await freshOrg('rename');
    const dataset = await createDataset(orgId, { name: 'original.csv' }, dbAdmin);
    const payload = "'; DROP TABLE datasets; --";

    await updateDatasetName(orgId, dataset!.id, payload, dbAdmin);

    const [read] = await dbAdmin.select().from(datasets).where(eq(datasets.id, dataset!.id));
    expect(read!.name).toBe(payload);
  });

  it('treats a tautology as a literal rather than a predicate', async () => {
    const orgId = await freshOrg('taut');
    const dataset = await createDataset(orgId, { name: 'taut.csv' }, dbAdmin);
    const tautology = "' OR '1'='1";

    await insertBatch(
      orgId,
      dataset!.id,
      [
        { category: tautology, date: new Date('2026-01-15'), amount: '1.00' },
        { category: 'ordinary', date: new Date('2026-01-16'), amount: '2.00' },
      ],
      dbAdmin,
    );

    const matches = await dbAdmin
      .select()
      .from(dataRows)
      .where(eq(dataRows.category, tautology));

    // Scoped to this dataset so the count does not depend on what other tests
    // left behind. Interpreted, the tautology matches both rows; parameterised,
    // only the one literally named that.
    const mine = matches.filter((m) => m.datasetId === dataset!.id);
    expect(mine).toHaveLength(1);
  });

  it('still has the tables every payload tried to drop', async () => {
    const rows = await dbAdmin.execute<{ data_rows: boolean; datasets: boolean }>(
      sql`SELECT to_regclass('public.data_rows') IS NOT NULL AS data_rows,
                 to_regclass('public.datasets')  IS NOT NULL AS datasets`,
    );
    expect(rows[0]?.data_rows).toBe(true);
    expect(rows[0]?.datasets).toBe(true);
  });
});
