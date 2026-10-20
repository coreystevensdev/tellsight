import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { withRlsContext } from '../../lib/rls.js';
import { orgs, categoryPlans } from '../schema.js';
import { listCategoryPlans, upsertCategoryPlans, deleteCategoryPlan } from './categoryPlans.js';

// Against real Postgres because the parts worth testing are the parts a mock
// invents: ON CONFLICT DO UPDATE resolving to an update rather than a duplicate
// row, `excluded.planned_monthly` naming the incoming value, and numeric(12,2)
// coming back as a string. A mocked client would answer whatever it was told.
//
// Every call under test goes through withRlsContext rather than the module's
// default client. The default is `db`, which connects as the RLS-scoped app_user,
// so without an org context set these functions fail the tenant_isolation policy
// on write and match nothing on read. That is the route path, and running the
// tests through it means the cross-org cases below exercise the policy instead of
// only the WHERE clause.
const asOrg = <T>(orgId: number, fn: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>) =>
  withRlsContext(orgId, false, fn);

const createdOrgs: number[] = [];
let orgId: number;
let otherOrgId: number;

async function makeOrg(label: string): Promise<number> {
  const slug = `catplan-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [org] = await dbAdmin.insert(orgs).values({ name: label, slug }).returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  return org!.id;
}

beforeAll(async () => {
  orgId = await makeOrg('primary');
  otherOrgId = await makeOrg('other');
});

afterAll(async () => {
  if (createdOrgs.length) {
    await dbAdmin.delete(categoryPlans).where(inArray(categoryPlans.orgId, createdOrgs));
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
});

describe('upsertCategoryPlans against real Postgres', () => {
  it('inserts plans and reads the numeric back as a number', async () => {
    const result = await asOrg(orgId, (tx) =>
      upsertCategoryPlans(orgId, [
        { category: 'Rent', plannedMonthly: 2400 },
        { category: 'Payroll', plannedMonthly: 18500.5 },
      ], tx),
    );

    expect(result).toEqual([
      { category: 'Payroll', plannedMonthly: 18500.5 },
      { category: 'Rent', plannedMonthly: 2400 },
    ]);
  });

  it('updates an existing category instead of inserting a second row', async () => {
    await asOrg(orgId, (tx) => upsertCategoryPlans(orgId, [{ category: 'Rent', plannedMonthly: 2600 }], tx));

    const rent = (await asOrg(orgId, (tx) => listCategoryPlans(orgId, tx))).filter((p) => p.category === 'Rent');
    expect(rent).toEqual([{ category: 'Rent', plannedMonthly: 2600 }]);
  });

  // Postgres refuses an ON CONFLICT DO UPDATE that would touch the same row
  // twice in one statement, so without the collapse in upsertCategoryPlans this
  // throws rather than returning a wrong number.
  it('collapses a category named twice in one payload, last value winning', async () => {
    const result = await asOrg(orgId, (tx) =>
      upsertCategoryPlans(orgId, [
        { category: 'Software', plannedMonthly: 100 },
        { category: 'Software', plannedMonthly: 250 },
      ], tx),
    );

    const software = result.filter((p) => p.category === 'Software');
    expect(software).toEqual([{ category: 'Software', plannedMonthly: 250 }]);
  });

  it('leaves categories the payload omits alone', async () => {
    await asOrg(orgId, (tx) => upsertCategoryPlans(orgId, [{ category: 'Rent', plannedMonthly: 2700 }], tx));

    const categories = (await asOrg(orgId, (tx) => listCategoryPlans(orgId, tx))).map((p) => p.category);
    expect(categories).toContain('Payroll');
  });

  it('keeps one org out of another org plans', async () => {
    await asOrg(otherOrgId, (tx) => upsertCategoryPlans(otherOrgId, [{ category: 'Rent', plannedMonthly: 999 }], tx));

    const mine = (await asOrg(orgId, (tx) => listCategoryPlans(orgId, tx))).find((p) => p.category === 'Rent');
    const theirs = await asOrg(otherOrgId, (tx) => listCategoryPlans(otherOrgId, tx));
    expect(mine?.plannedMonthly).toBe(2700);
    expect(theirs).toEqual([{ category: 'Rent', plannedMonthly: 999 }]);
  });

  it('stores a zero plan rather than treating it as unset', async () => {
    await asOrg(orgId, (tx) => upsertCategoryPlans(orgId, [{ category: 'Travel', plannedMonthly: 0 }], tx));

    const travel = (await asOrg(orgId, (tx) => listCategoryPlans(orgId, tx))).find((p) => p.category === 'Travel');
    expect(travel).toEqual({ category: 'Travel', plannedMonthly: 0 });
  });
});

describe('deleteCategoryPlan', () => {
  it('reports whether a row was actually removed', async () => {
    await asOrg(orgId, (tx) => upsertCategoryPlans(orgId, [{ category: 'Marketing', plannedMonthly: 500 }], tx));

    expect(await asOrg(orgId, (tx) => deleteCategoryPlan(orgId, 'Marketing', tx))).toBe(true);
    expect(await asOrg(orgId, (tx) => deleteCategoryPlan(orgId, 'Marketing', tx))).toBe(false);
  });

  it('does not delete another org row of the same category', async () => {
    expect(await asOrg(orgId, (tx) => deleteCategoryPlan(orgId, 'Rent', tx))).toBe(true);

    const theirs = await asOrg(otherOrgId, (tx) => listCategoryPlans(otherOrgId, tx));
    expect(theirs).toEqual([{ category: 'Rent', plannedMonthly: 999 }]);
  });
});
