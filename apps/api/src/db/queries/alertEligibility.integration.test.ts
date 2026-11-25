import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions, datasets, alertRules } from '../schema.js';
import { findEligibleOrgs } from './alertEligibility.js';

// Real Postgres. alertEligibility.test.ts asserts which predicates get emitted
// and cannot say whether a row comes back, which is the hole that hid the digest
// defect in #432: nothing executed the predicate, so nothing noticed what it was
// scoped to. The seed cases here are the ones worth executing, because a rule
// evaluated against seed rows fires an alert about numbers we generated at
// signup rather than the owner's business.

interface Seed {
  label: string;
  orgId: number;
}

const seeded: Seed[] = [];

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function seedOrg(
  label: string,
  opts: {
    activeIsSeed?: boolean;
    alsoSeedDataset?: boolean;
    withRule?: boolean;
    withDataset?: boolean;
  } = {},
): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `alert-elig-${label}-${uniq()}` })
    .returning({ id: orgs.id });
  const orgId = org!.id;

  if (opts.withDataset ?? true) {
    // A seed dataset the org is NOT pointed at. This is what separates "the
    // active dataset is seed" from "the org owns a seed dataset" -- an
    // exists-over-all-datasets predicate would wrongly drop this org.
    if (opts.alsoSeedDataset) {
      await dbAdmin.insert(datasets).values({ orgId, name: 'Demo Data', isSeedData: true });
    }
    const [dataset] = await dbAdmin
      .insert(datasets)
      .values({ orgId, name: 'Active Dataset', isSeedData: opts.activeIsSeed ?? false })
      .returning({ id: datasets.id });
    await dbAdmin.update(orgs).set({ activeDatasetId: dataset!.id }).where(eq(orgs.id, orgId));
  }

  await dbAdmin
    .insert(subscriptions)
    .values({ orgId, status: 'active', plan: 'pro', currentPeriodEnd: null });

  if (opts.withRule ?? true) {
    await dbAdmin.insert(alertRules).values({
      orgId,
      kind: 'margin_drops',
      threshold: { dropPercent: 10 },
      enabled: true,
    });
  }

  seeded.push({ label, orgId });
  return orgId;
}

beforeAll(async () => {
  await seedOrg('real-dataset-with-rule');
  await seedOrg('seed-dataset-with-rule', { activeIsSeed: true });
  await seedOrg('real-active-plus-seed-dataset', { alsoSeedDataset: true });
  await seedOrg('real-dataset-no-rule', { withRule: false });
  await seedOrg('no-dataset-with-rule', { withDataset: false });
});

afterAll(async () => {
  const ids = seeded.map((s) => s.orgId);
  if (ids.length > 0) await dbAdmin.delete(orgs).where(inArray(orgs.id, ids));
});

// Pages through every result rather than trusting the seeded orgs land on page
// one: the tables are shared across this whole integration suite, so another
// spec's fixtures could otherwise push ours past a single page.
async function findAllEligibleOrgIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  let cursor: number | undefined;
  for (;;) {
    const page = await findEligibleOrgs(cursor, 500);
    if (page.length === 0) break;
    for (const row of page) ids.add(row.id);
    cursor = page[page.length - 1]!.id;
  }
  return ids;
}

describe('findEligibleOrgs excludes orgs whose active dataset is seed data', () => {
  it('includes real active datasets and excludes a seed one', async () => {
    const eligible = await findAllEligibleOrgIds();
    const labelById = new Map(seeded.map((s) => [s.orgId, s.label]));
    const matched = seeded.filter((s) => eligible.has(s.orgId)).map((s) => labelById.get(s.orgId));

    expect(matched).toContain('real-dataset-with-rule');
    expect(matched).not.toContain('seed-dataset-with-rule');
    expect(matched).not.toContain('real-dataset-no-rule');
    expect(matched).not.toContain('no-dataset-with-rule');
  });

  it('keeps an org whose active dataset is real but which also owns a seed dataset', async () => {
    const eligible = await findAllEligibleOrgIds();
    const org = seeded.find((s) => s.label === 'real-active-plus-seed-dataset')!;

    expect(eligible.has(org.orgId)).toBe(true);
  });

  // Its own org on purpose. Flipping a fixture the sibling tests assert on is
  // how a mutation leaks into whichever test happens to run next, which is a
  // mistake the digest freshness suite already made once.
  it('drops an org the moment its active dataset is pointed at seed rows', async () => {
    const orgId = await seedOrg('flipped-to-seed');
    const before = await findAllEligibleOrgIds();
    expect(before.has(orgId)).toBe(true);

    const [seedDs] = await dbAdmin
      .insert(datasets)
      .values({ orgId, name: 'Flipped To Seed', isSeedData: true })
      .returning({ id: datasets.id });
    await dbAdmin.update(orgs).set({ activeDatasetId: seedDs!.id }).where(eq(orgs.id, orgId));

    const after = await findAllEligibleOrgIds();
    expect(after.has(orgId)).toBe(false);
  });
});
