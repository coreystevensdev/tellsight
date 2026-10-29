import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { withRlsContext } from '../../lib/rls.js';
import { cashBalanceSnapshots, orgs } from '../schema.js';
import { getCashBalanceHistory, getOrgFinancials, updateOrgFinancials } from './orgFinancials.js';

// These queries depend on Postgres behavior a mock cannot establish: JSONB ||
// merging, numeric-to-number conversion, RLS on the append-only history table,
// and the update + snapshot sharing one transaction.
const asOrg = <T>(
  orgId: number,
  fn: (tx: Parameters<Parameters<typeof withRlsContext>[2]>[0]) => Promise<T>,
) => withRlsContext(orgId, false, fn);

const createdOrgs: number[] = [];
let orgId: number;
let otherOrgId: number;

async function makeOrg(label: string, businessProfile: Record<string, unknown> | null = null) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: label, slug: `financials-${label}-${suffix}`, businessProfile })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);
  return org!.id;
}

beforeAll(async () => {
  orgId = await makeOrg('primary', {
    businessType: 'services',
    revenueRange: '100k_500k',
    teamSize: '2_5',
    topConcern: 'cash_flow',
    businessStartedDate: '2021-04-12',
  });
  otherOrgId = await makeOrg('other', {
    businessType: 'retail',
    revenueRange: 'under_100k',
    teamSize: 'solo',
    topConcern: 'growth',
  });
});

afterAll(async () => {
  if (createdOrgs.length > 0) {
    await dbAdmin
      .delete(cashBalanceSnapshots)
      .where(inArray(cashBalanceSnapshots.orgId, createdOrgs));
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
});

describe('organization financial persistence', () => {
  it('returns the financial subset and preserves onboarding fields when merging updates', async () => {
    const updated = await asOrg(orgId, (tx) =>
      updateOrgFinancials(
        orgId,
        {
          cashOnHand: 12_345.67,
          cashAsOfDate: '2026-08-01T12:00:00.000Z',
          monthlyFixedCosts: 4_500,
        },
        tx,
      ),
    );

    expect(updated).toEqual({
      cashOnHand: 12_345.67,
      cashAsOfDate: '2026-08-01T12:00:00.000Z',
      businessStartedDate: '2021-04-12',
      monthlyFixedCosts: 4_500,
    });

    const stored = await dbAdmin.query.orgs.findFirst({ where: eq(orgs.id, orgId) });
    expect(stored?.businessProfile).toMatchObject({
      businessType: 'services',
      revenueRange: '100k_500k',
      teamSize: '2_5',
      topConcern: 'cash_flow',
      cashOnHand: 12_345.67,
    });
  });

  it('appends a cash snapshot but does not append one for non-cash or empty updates', async () => {
    const before = await dbAdmin
      .select()
      .from(cashBalanceSnapshots)
      .where(eq(cashBalanceSnapshots.orgId, orgId));

    await asOrg(orgId, (tx) =>
      updateOrgFinancials(
        orgId,
        { cashOnHand: 11_000, cashAsOfDate: '2026-09-01T00:00:00.000Z' },
        tx,
      ),
    );
    await asOrg(orgId, (tx) => updateOrgFinancials(orgId, { monthlyFixedCosts: 4_750 }, tx));
    await asOrg(orgId, (tx) => updateOrgFinancials(orgId, {}, tx));

    const after = await dbAdmin
      .select()
      .from(cashBalanceSnapshots)
      .where(eq(cashBalanceSnapshots.orgId, orgId));
    expect(after).toHaveLength(before.length + 1);
    expect(after).toContainEqual(expect.objectContaining({ balance: '11000.00' }));
  });

  it('rolls the profile update back when RLS rejects its snapshot insert', async () => {
    const before = await dbAdmin.query.orgs.findFirst({ where: eq(orgs.id, otherOrgId) });

    await expect(
      // The profile table itself is not RLS-protected, so the UPDATE runs. The
      // history INSERT is protected and fails, proving both writes really share
      // the surrounding transaction only if the profile change also disappears.
      asOrg(orgId, (tx) =>
        updateOrgFinancials(
          otherOrgId,
          { cashOnHand: 999, cashAsOfDate: '2026-10-01T00:00:00.000Z' },
          tx,
        ),
      ),
    ).rejects.toThrow();

    const after = await dbAdmin.query.orgs.findFirst({ where: eq(orgs.id, otherOrgId) });
    expect(after?.businessProfile).toEqual(before?.businessProfile);
  });

  it('returns history newest-first, converts numeric values, and clamps limits', async () => {
    for (const [cashOnHand, cashAsOfDate] of [
      [9_000, '2026-09-10T00:00:00.000Z'],
      [9_500, '2026-09-20T00:00:00.000Z'],
      [10_000, '2026-10-01T00:00:00.000Z'],
    ] as const) {
      await asOrg(orgId, (tx) => updateOrgFinancials(orgId, { cashOnHand, cashAsOfDate }, tx));
    }

    const latest = await asOrg(orgId, (tx) => getCashBalanceHistory(orgId, 0, tx));
    expect(latest).toEqual([{ balance: 10_000, asOfDate: '2026-10-01T00:00:00.000Z' }]);

    const all = await asOrg(orgId, (tx) => getCashBalanceHistory(orgId, 100, tx));
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.map((row) => row.asOfDate)).toEqual(
      [...all.map((row) => row.asOfDate)].sort().reverse(),
    );
    expect(all.every((row) => typeof row.balance === 'number')).toBe(true);
  });

  it('does not expose another organization cash history', async () => {
    await asOrg(otherOrgId, (tx) =>
      updateOrgFinancials(
        otherOrgId,
        { cashOnHand: 777, cashAsOfDate: '2026-07-01T00:00:00.000Z' },
        tx,
      ),
    );

    // Deliberately ask for the other org id while carrying this org's RLS
    // context. The WHERE clause alone would return the row; the policy must
    // suppress it.
    const leaked = await asOrg(orgId, (tx) => getCashBalanceHistory(otherOrgId, 60, tx));
    expect(leaked).toEqual([]);
  });
});

describe('an organization with no profile', () => {
  it('returns null', async () => {
    const emptyOrgId = await makeOrg('empty');
    expect(await asOrg(emptyOrgId, (tx) => getOrgFinancials(emptyOrgId, tx))).toBeNull();
  });
});
