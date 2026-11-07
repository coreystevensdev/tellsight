import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, datasets } from '../schema.js';
import { insertBatch } from './dataRows.js';
import { getCategoryVarianceWindow } from './charts.js';

// charts.test.ts mocks the query builder, so its WHERE clauses are never
// actually evaluated there; a mock that returns canned rows regardless of
// what SQL was built cannot prove the SQL excludes the right month or sums
// the right sign. Both of those only showed up once a reviewer rendered the
// real query against real Postgres instead of trusting the mocked result.

const suffix = `category-variance-${process.pid}`;
const createdOrgs: number[] = [];
let orgId: number;
let datasetId: number;

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'category variance', slug: suffix })
    .returning({ id: orgs.id });
  orgId = org!.id;
  createdOrgs.push(orgId);

  const [dataset] = await dbAdmin
    .insert(datasets)
    .values({ orgId, name: 'Variance' })
    .returning({ id: datasets.id });
  datasetId = dataset!.id;

  await insertBatch(
    orgId,
    datasetId,
    [
      // Rent is split one positive, one negative row in the same month. Raw
      // sum() nets these to 300, which would have passed the old code
      // without ever exposing the sign bug; abs-then-sum is the only way to
      // land on 1700, the total an owner comparing against a typed-in plan
      // actually expects.
      { category: 'Rent', parentCategory: 'Expenses', date: new Date('2026-01-10'), amount: '1000.00' },
      { category: 'Rent', parentCategory: 'Expenses', date: new Date('2026-01-20'), amount: '-700.00' },
      // A row dated past the "current" month this test passes in. The old
      // `<>` filter only excludes the current month by name and lets
      // anything later win max(); this one row, left in, would make the
      // target month March instead of January.
      { category: 'Rent', parentCategory: 'Expenses', date: new Date('2026-03-05'), amount: '500.00' },
      // DW-232: a Shopify product row, carrying inventory value rather than
      // spend and dated syncedAt. February is complete once "now" is March, so
      // before the month query filtered on Expenses this row won max() and
      // named a month the actuals query found no expenses in, reporting Rent as
      // 100% under plan.
      { category: 'snowboard', parentCategory: 'Other', date: new Date('2026-02-11'), amount: '503734.60' },
    ],
    dbAdmin,
  );
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

describe('getCategoryVarianceWindow against real Postgres', () => {
  it('sums the absolute value of a category with both signs of amount', async () => {
    const window = await getCategoryVarianceWindow(orgId, dbAdmin, datasetId, new Date('2026-02-15'));

    expect(window?.monthLabel).toBe('Jan 2026');
    expect(window?.actualByCategory.get('Rent')).toBe(1700);
  });

  it('resolves the latest month strictly before "now", not just unequal to it', async () => {
    // now = Feb, so January is the latest complete month. The March row
    // exists specifically to outrank January under the old `<>` filter,
    // since March is not equal to February either.
    const window = await getCategoryVarianceWindow(orgId, dbAdmin, datasetId, new Date('2026-02-15'));

    expect(window?.monthLabel).toBe('Jan 2026');
  });

  it('treats the March row as the current month once "now" catches up to it, excluding it too', async () => {
    const window = await getCategoryVarianceWindow(orgId, dbAdmin, datasetId, new Date('2026-03-20'));

    expect(window?.monthLabel).toBe('Jan 2026');
  });

  it('does not let a non-expense row choose the month', async () => {
    // The snowboard row is February, later than January and complete as of
    // March. If anything but Expenses can win max(), the window is Feb 2026,
    // which holds no expense rows, so actualByCategory comes back empty and
    // every planned category reads as fully unspent.
    const window = await getCategoryVarianceWindow(orgId, dbAdmin, datasetId, new Date('2026-03-20'));

    expect(window?.monthLabel).toBe('Jan 2026');
    expect(window?.actualByCategory.get('Rent')).toBe(1700);
    expect(window?.actualByCategory.has('snowboard')).toBe(false);
  });
});
