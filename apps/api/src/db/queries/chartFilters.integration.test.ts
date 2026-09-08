import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, datasets } from '../schema.js';
import { insertBatch } from './dataRows.js';
import { getChartData } from './charts.js';

// The date range is pushed into SQL, and charts.test.ts stubs the query builder's
// .where() to a no-op, so both predicates could be deleted with 2,509 unit and
// 124 integration tests green. Filtering a dashboard by date would then quietly
// return every row the org has ever uploaded.
//
// Ranges are asserted from both ends. A predicate that filters nothing and one
// that filters everything both look like "the date filter works" if the only
// check is that something came back.

const suffix = `chart-filters-${process.pid}`;
const createdOrgs: number[] = [];
let orgId: number;
let datasetId: number;

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'chart filters', slug: suffix })
    .returning({ id: orgs.id });
  orgId = org!.id;
  createdOrgs.push(orgId);

  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId, name: 'Filters' })
    .returning({ id: datasets.id });
  datasetId = dataset!.id;

  // One row per month across three months, each a distinct amount so a bucket
  // can be identified by its total.
  await insertBatch(
    orgId,
    datasetId,
    [
      { category: 'Revenue', parentCategory: 'Income', date: new Date('2026-01-15'), amount: '100.00' },
      { category: 'Revenue', parentCategory: 'Income', date: new Date('2026-02-15'), amount: '200.00' },
      { category: 'Revenue', parentCategory: 'Income', date: new Date('2026-03-15'), amount: '400.00' },
    ],
    dbAdmin,
  );
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

async function revenueTotal(filters?: Parameters<typeof getChartData>[1]): Promise<number> {
  const data = await getChartData(orgId, filters, undefined, dbAdmin, datasetId);
  return data.revenueTrend.reduce((sum, point) => sum + point.revenue, 0);
}

describe('getChartData date filtering against real Postgres', () => {
  it('sums every month when no range is given', async () => {
    expect(await revenueTotal()).toBe(700);
  });

  // dateFrom alone: the January row has to drop out, which is the half a missing
  // gte() would leave in.
  it('excludes rows before dateFrom', async () => {
    const total = await revenueTotal({ dateFrom: new Date('2026-02-01') });

    expect(total).toBe(600);
  });

  // And the mirror for lte().
  it('excludes rows after dateTo', async () => {
    const total = await revenueTotal({ dateTo: new Date('2026-02-28') });

    expect(total).toBe(300);
  });

  it('keeps only the months inside a closed range', async () => {
    const total = await revenueTotal({
      dateFrom: new Date('2026-02-01'),
      dateTo: new Date('2026-02-28'),
    });

    expect(total).toBe(200);
  });

  // A range with nothing in it must come back empty rather than falling through
  // to everything, which is what dropping the predicates looks like.
  it('returns nothing for a range the data does not reach', async () => {
    const total = await revenueTotal({
      dateFrom: new Date('2027-01-01'),
      dateTo: new Date('2027-12-31'),
    });

    expect(total).toBe(0);
  });

  // The metadata query is deliberately unfiltered: the date pickers need the full
  // span of the dataset, not the span of the current selection, or narrowing once
  // would make it impossible to widen again.
  it('reports the full date range regardless of the filter applied', async () => {
    const narrowed = await getChartData(
      orgId,
      { dateFrom: new Date('2026-02-01'), dateTo: new Date('2026-02-28') },
      undefined,
      dbAdmin,
      datasetId,
    );

    expect(narrowed.dateRange?.min).toContain('2026-01');
    expect(narrowed.dateRange?.max).toContain('2026-03');
  });
});
