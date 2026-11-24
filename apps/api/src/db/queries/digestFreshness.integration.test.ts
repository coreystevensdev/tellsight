import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, userOrgs, subscriptions, datasets } from '../schema.js';
import {
  findEligibleOrgs,
  countOrgsPausedForStaleData,
  findOrgsNeedingStaleNudge,
  DATASET_FRESHNESS_DAYS,
} from './digestEligibility.js';

// The sibling cadence suite exists because .toSQL() shape assertions cannot tell
// whether a row comes back. The freshness gate had the same hole and it hid a
// real defect: every assertion in digestEligibility.test.ts reads rendered SQL,
// so nothing executed the 30-day predicate and nothing noticed it was scoped to
// the active dataset alone.
//
// Boundaries are asserted from both sides for the reason that suite gives: a
// predicate matching everything and one matching nothing both look correct from
// a single row.

const createdOrgs: number[] = [];
const createdUsers: number[] = [];

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** A bare Date is a real dataset; seedAt marks one as seed rows. */
type Refresh = Date | { at: Date; seed: true };
const seedAt = (at: Date): Refresh => ({ at, seed: true });

/**
 * A paying org with one opted-in member, which is every eligibility gate except
 * freshness. `refreshes` becomes one dataset per entry; the first is the active
 * one, matching what an org looks like after its first connector claims the
 * dashboard and later ones keep their own datasets.
 */
async function payingOrg(label: string, refreshes: Refresh[]): Promise<number> {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `freshness ${label}`, slug: `freshness-${label}-${uniq()}` })
    .returning({ id: orgs.id });
  const orgId = org!.id;
  createdOrgs.push(orgId);

  await dbAdmin.insert(subscriptions).values({ orgId, status: 'active', plan: 'pro' });

  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `freshness-${label}-${uniq()}@test.local`, name: label })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  // No digest_preferences row at all, which the gate reads as opted in.
  await dbAdmin.insert(userOrgs).values({ orgId, userId: user!.id, role: 'owner' });

  const ids: number[] = [];
  for (const [i, r] of refreshes.entries()) {
    const at = r instanceof Date ? r : r.at;
    const [ds] = await dbAdmin
      .insert(datasets)
      .values({
        orgId,
        name: `${label}-ds-${i}`,
        dataRefreshedAt: at,
        isSeedData: !(r instanceof Date),
      })
      .returning({ id: datasets.id });
    ids.push(ds!.id);
  }
  await dbAdmin.update(orgs).set({ activeDatasetId: ids[0]! }).where(inArray(orgs.id, [orgId]));

  return orgId;
}

let freshActive: number;
let staleActive: number;
let staleActiveFreshSecond: number;
let allStale: number;

beforeAll(async () => {
  freshActive = await payingOrg('fresh', [daysAgo(DATASET_FRESHNESS_DAYS - 1)]);
  staleActive = await payingOrg('stale', [daysAgo(DATASET_FRESHNESS_DAYS + 1)]);
  // The defect's shape: the dashboard sits on a connector that went quiet while a
  // second connector keeps syncing. #410 is what makes this reachable, since it
  // leaves the active pointer alone once an org has a real dataset.
  staleActiveFreshSecond = await payingOrg('split', [daysAgo(DATASET_FRESHNESS_DAYS + 10), daysAgo(1)]);
  allStale = await payingOrg('cold', [daysAgo(DATASET_FRESHNESS_DAYS + 10), daysAgo(DATASET_FRESHNESS_DAYS + 5)]);
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe(`the ${DATASET_FRESHNESS_DAYS}-day freshness boundary, executed`, () => {
  it('includes an org one day inside the window', async () => {
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).toContain(freshActive);
  });

  it('excludes an org one day outside it', async () => {
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).not.toContain(staleActive);
  });
});

describe('freshness is the org\'s most recent receipt, not the active dataset\'s', () => {
  it('keeps an org eligible when a non-active dataset is the fresh one', async () => {
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).toContain(staleActiveFreshSecond);
  });

  it('still excludes an org whose every dataset is stale', async () => {
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).not.toContain(allStale);
  });
});

// These three populations have to agree. An org that is eligible and also counted
// as paused and also nudged would be told its digest stopped in the same week it
// received one, which is worse than the defect being fixed.
//
// Each test below owns the org it mutates. An earlier draft shared one and the
// mutation leaked: the paused-count test left every dataset of the cold org
// refreshed, so the timestamp test read a value the fix had not produced and
// passed against the unfixed query.
describe('the paused count and the nudge sweep agree with eligibility', () => {
  it('counts an org as paused only once its newest dataset goes stale', async () => {
    const split = await payingOrg('count', [daysAgo(DATASET_FRESHNESS_DAYS + 10), daysAgo(1)]);

    // Fresh somewhere, so not paused. Under the active-dataset-only predicate it
    // is already paused here and the count below does not move.
    const before = await countOrgsPausedForStaleData();

    await dbAdmin
      .update(datasets)
      .set({ dataRefreshedAt: daysAgo(DATASET_FRESHNESS_DAYS + 2) })
      .where(inArray(datasets.orgId, [split]));

    const after = await countOrgsPausedForStaleData();
    expect(after).toBe(before + 1);
  });

  it('does not nudge the split org, and does nudge the cold one', async () => {
    const ids = (await findOrgsNeedingStaleNudge()).map((o) => o.id);
    expect(ids).not.toContain(staleActiveFreshSecond);
    expect(ids).toContain(allStale);
  });

  it('reports the nudge timestamp from the org\'s newest dataset, not its active one', async () => {
    const cold = await payingOrg('stamp', [
      daysAgo(DATASET_FRESHNESS_DAYS + 40),
      daysAgo(DATASET_FRESHNESS_DAYS + 2),
    ]);
    const row = (await findOrgsNeedingStaleNudge()).find((o) => o.id === cold);
    expect(row).toBeDefined();
    const age = (Date.now() - row!.dataRefreshedAt.getTime()) / 86_400_000;
    // The newest is +2 past the window; the active one is +40 past it. A query
    // reading the active dataset reports the latter and fails this.
    expect(age).toBeLessThan(DATASET_FRESHNESS_DAYS + 10);
  });
});

// seedDemoData gives every new org a seed dataset and points activeDatasetId at
// it, so "paying, active dataset, something fresh" is satisfiable with nothing
// but rows we generated ourselves. Production org 7 was in that state for the
// 30 days after sign-up: active pro, zero real datasets, all four gates passing.
//
// Only an org with no real dataset is affected. Nothing backdates
// data_refreshed_at (touchDataRefreshed is its only writer and the five
// connector syncs its only callers, and db/seed.ts skips an org that already has
// seed rows), so a seed timestamp can never be the newest once a real dataset
// exists. All five production seed datasets have data_refreshed_at equal to
// created_at exactly.
//
// Two mutations, because they catch different things. Dropping the predicate
// fails the first four: seed rows get counted again. Inverting it to
// `and d.is_seed_data` fails the last one: real rows stop counting, its 60-day
// seed dataset becomes the max, and the org drops out. Neither mutation fails
// both ends, which is why the pair is here.
describe('seed rows are not data the org received', () => {
  it('does not make a paying org with nothing but seed rows eligible', async () => {
    const seedOnly = await payingOrg('seedonly', [seedAt(daysAgo(1))]);
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).not.toContain(seedOnly);
  });

  it('does not count that org as paused, since its digest never started', async () => {
    const before = await countOrgsPausedForStaleData();
    await payingOrg('seedpaused', [seedAt(daysAgo(DATASET_FRESHNESS_DAYS + 5))]);
    // Stale on purpose: counting the old way this org is paused and the number moves.
    const after = await countOrgsPausedForStaleData();
    expect(after).toBe(before);
  });

  it('does not nudge that org either, which would claim a digest had stopped', async () => {
    const seedOnly = await payingOrg('seednudge', [seedAt(daysAgo(DATASET_FRESHNESS_DAYS + 5))]);
    const ids = (await findOrgsNeedingStaleNudge()).map((o) => o.id);
    expect(ids).not.toContain(seedOnly);
  });

  it('does not let a fresh seed dataset rescue an org whose real data went stale', async () => {
    const masked = await payingOrg('masked', [
      daysAgo(DATASET_FRESHNESS_DAYS + 5),
      seedAt(daysAgo(1)),
    ]);
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).not.toContain(masked);
  });

  it('leaves an org with fresh real data eligible when it also holds seed rows', async () => {
    const both = await payingOrg('realplusseed', [daysAgo(1), seedAt(daysAgo(60))]);
    const ids = (await findEligibleOrgs(undefined, 500)).map((o) => o.id);
    expect(ids).toContain(both);
  });
});
