import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, subscriptions, datasets } from '../schema.js';
import { findEligibleOrgs } from './agentEligibility.js';

// Real Postgres, no mocks -- the SQL-shape tests in agentEligibility.test.ts
// prove which predicates get emitted; this proves they actually filter real
// rows the way the grace-period branch (DW-165/DW-190) intends. Lives under
// vitest.integration.config.ts so the default `pnpm test` never picks it up.

interface Seed {
  label: string;
  orgId: number;
}

const seeded: Seed[] = [];

async function seedOrg(
  label: string,
  sub: { status: string; plan?: string; agentEnabled?: boolean; currentPeriodEnd?: Date | null },
  opts: { withDataset?: boolean } = {},
): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `agent-elig-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}` })
    .returning({ id: orgs.id });
  const orgId = org!.id;

  if (opts.withDataset ?? true) {
    const [dataset] = await dbAdmin
      .insert(datasets)
      .values({ orgId, name: 'Test Dataset' })
      .returning({ id: datasets.id });
    await dbAdmin.update(orgs).set({ activeDatasetId: dataset!.id }).where(eq(orgs.id, orgId));
  }

  await dbAdmin.insert(subscriptions).values({
    orgId,
    status: sub.status,
    plan: sub.plan ?? 'pro',
    agentEnabled: sub.agentEnabled ?? true,
    currentPeriodEnd: sub.currentPeriodEnd ?? null,
  });

  seeded.push({ label, orgId });
  return orgId;
}

beforeAll(async () => {
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  await seedOrg('active-in-period', { status: 'active' });
  await seedOrg('canceled-grace-period', { status: 'canceled', currentPeriodEnd: future });
  await seedOrg('canceled-grace-expired', { status: 'canceled', currentPeriodEnd: past });
  await seedOrg('canceled-no-period-end', { status: 'canceled', currentPeriodEnd: null });
  await seedOrg('past-due', { status: 'past_due' });
  await seedOrg('active-not-pro', { status: 'active', plan: 'free' });
  await seedOrg('active-agent-disabled', { status: 'active', agentEnabled: false });
  await seedOrg('active-no-dataset', { status: 'active' }, { withDataset: false });
});

afterAll(async () => {
  const ids = seeded.map((s) => s.orgId);
  if (ids.length > 0) await dbAdmin.delete(orgs).where(inArray(orgs.id, ids));
});

// Pages through every result rather than trusting the seeded orgs land on
// page one -- the eligibility table is shared across this whole integration
// suite, so a prior run's leftover rows (or another spec's fixtures) could
// otherwise push our orgs past a single page and produce a false negative.
async function findAllEligibleOrgIds(asOf?: Date): Promise<Set<number>> {
  const ids = new Set<number>();
  let cursor: number | undefined;
  for (;;) {
    const page = await findEligibleOrgs(cursor, 500, asOf);
    if (page.length === 0) break;
    for (const row of page) ids.add(row.id);
    cursor = page[page.length - 1]!.id;
  }
  return ids;
}

describe('findEligibleOrgs against real Postgres (DW-194 row-level coverage)', () => {
  it('includes active and canceled-in-grace-period orgs, excludes every other seeded case', async () => {
    const eligibleIds = await findAllEligibleOrgIds();
    const labelById = new Map(seeded.map((s) => [s.orgId, s.label]));
    const matchedLabels = seeded.filter((s) => eligibleIds.has(s.orgId)).map((s) => labelById.get(s.orgId));

    expect(matchedLabels).toContain('active-in-period');
    expect(matchedLabels).toContain('canceled-grace-period');
    expect(matchedLabels).not.toContain('canceled-grace-expired');
    expect(matchedLabels).not.toContain('canceled-no-period-end');
    expect(matchedLabels).not.toContain('past-due');
    expect(matchedLabels).not.toContain('active-not-pro');
    expect(matchedLabels).not.toContain('active-agent-disabled');
    expect(matchedLabels).not.toContain('active-no-dataset');
  });

  it('excludes a canceled org once asOf is pinned past its grace period', async () => {
    const graceEnd = new Date(Date.now() + 60 * 60 * 1000);
    const orgId = await seedOrg('asof-pinned-grace', { status: 'canceled', currentPeriodEnd: graceEnd });

    const beforeExpiry = await findAllEligibleOrgIds(new Date(graceEnd.getTime() - 1000));
    const atExpiry = await findAllEligibleOrgIds(graceEnd);
    const afterExpiry = await findAllEligibleOrgIds(new Date(graceEnd.getTime() + 1000));

    expect(beforeExpiry.has(orgId)).toBe(true);
    // gt() is strict: an org whose currentPeriodEnd exactly equals asOf has
    // no grace period left, not one instant of it.
    expect(atExpiry.has(orgId)).toBe(false);
    expect(afterExpiry.has(orgId)).toBe(false);
  });
});
