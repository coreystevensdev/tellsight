import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs } from '../schema.js';
import { getBusinessProfile, updateBusinessProfile } from './orgs.js';

// updateBusinessProfile replaced the whole JSONB column, and the financial
// baseline (cashOnHand, cashAsOfDate, businessStartedDate, monthlyFixedCosts)
// shares that column with the four onboarding answers. So completing onboarding
// deleted the baseline, with no cash_balance_snapshots row and no
// FINANCIALS_UPDATED audit entry to show it had happened. Those values feed
// runway, break-even, cash forecast, the AI prompt and the weekly digest.
//
// Real Postgres because the fix is `COALESCE(...) || jsonb`, which only behaves
// like a merge inside the database. A mocked client would accept either query.

const SLUG = 'profile-merge-probe';
const ONBOARDING = {
  businessType: 'retail',
  revenueRange: '100k_500k',
  teamSize: 'solo',
  topConcern: 'cash_flow',
} as const;
const BASELINE = {
  cashOnHand: 25_000,
  cashAsOfDate: '2026-01-01T00:00:00.000Z',
  businessStartedDate: '2020-01-01',
  monthlyFixedCosts: 8_000,
};

let orgId: number;

beforeEach(async () => {
  await dbAdmin.delete(orgs).where(eq(orgs.slug, SLUG));
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'profile merge probe', slug: SLUG, businessProfile: BASELINE })
    .returning({ id: orgs.id });
  orgId = org!.id;
});

afterAll(async () => {
  await dbAdmin.delete(orgs).where(eq(orgs.slug, SLUG));
});

describe('updateBusinessProfile', () => {
  it('keeps the financial baseline when onboarding writes the four answers', async () => {
    await updateBusinessProfile(orgId, { ...ONBOARDING });

    const [row] = await dbAdmin
      .select({ profile: orgs.businessProfile })
      .from(orgs)
      .where(eq(orgs.id, orgId));
    const stored = row!.profile as Record<string, unknown>;

    expect(stored).toMatchObject(ONBOARDING);
    expect(stored).toMatchObject(BASELINE);
  });

  it('still overwrites a key it does send', async () => {
    await updateBusinessProfile(orgId, { ...ONBOARDING, businessType: 'services' });

    const profile = await getBusinessProfile(orgId);

    expect(profile?.businessType).toBe('services');
  });

  // An org with nothing stored yet is the common case on first onboarding, and
  // COALESCE is what keeps `null || jsonb` from evaluating to null.
  it('writes into a null column rather than producing null', async () => {
    await dbAdmin.update(orgs).set({ businessProfile: null }).where(eq(orgs.id, orgId));

    await updateBusinessProfile(orgId, { ...ONBOARDING });

    const profile = await getBusinessProfile(orgId);

    expect(profile).toMatchObject(ONBOARDING);
  });
});
