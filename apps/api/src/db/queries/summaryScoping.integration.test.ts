import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { orgs, users } from '../schema.js';
import { createDataset } from './datasets.js';
import { getCachedSummary, markStale, storeSummary } from './aiSummaries.js';
import { findOrgById, findOrgBySlug } from './orgs.js';
import { getByUserId, upsertDefaults, setCadence } from './digestPreferences.js';
import { dbAdmin } from '../../lib/db.js';

// getCachedSummary carries four predicates and its unit test asserts
// `toHaveBeenCalledWith({ where: expect.anything() })`, which any non-null value
// satisfies. All four could be deleted and it stays green. Two of them are not
// tenant scoping but meaning:
//
//   audience = 'dashboard'  a digest or alert summary would be served as the
//                           dashboard one, which is a different piece of writing
//                           about a different window
//   staleAt IS NULL         a summary invalidated by a fresh upload would keep
//                           being served
//
// The others here are the same shape: an identity or per-user lookup whose only
// assertion is that a query ran.

const suffix = `sumscope-${process.pid}`;
const createdOrgs: number[] = [];
const createdUsers: number[] = [];

let orgA: number;
let orgB: number;
let datasetA: number;
let datasetB: number;
let userA: number;
let userB: number;

beforeAll(async () => {
  for (const label of ['a', 'b']) {
    const [org] = await dbAdmin
      .insert(orgs)
      .values({ name: `sum ${label} ${suffix}`, slug: `sum-${label}-${suffix}` })
      .returning();
    createdOrgs.push(org!.id);

    const [user] = await dbAdmin
      .insert(users)
      .values({ email: `sum-${label}-${suffix}@example.com`, name: `sum ${label}` })
      .returning();
    createdUsers.push(user!.id);

    const dataset = await createDataset(org!.id, { name: `sum-${label}.csv` }, dbAdmin);

    // Seeded FIRST, deliberately. getCachedSummary's findFirst has no orderBy,
    // so without the audience predicate it returns whichever row comes first.
    // With the dashboard row inserted first the test passed even with the
    // predicate deleted, which is the "passes for the wrong reason" trap this
    // whole exercise is about. Digest first means a missing predicate returns
    // the wrong row.
    await storeSummary({
      orgId: org!.id,
      datasetId: dataset!.id,
      content: `digest summary for ${label}`,
      metadata: {},
      promptVersion: 'v1',
      audience: 'digest-weekly',
      weekStart: new Date('2026-01-05'),
      client: dbAdmin,
    });

    // The live dashboard summary this org should get back.
    await storeSummary({
      orgId: org!.id,
      datasetId: dataset!.id,
      content: `dashboard summary for ${label}`,
      metadata: {},
      promptVersion: 'v1',
      client: dbAdmin,
    });

    if (label === 'a') {
      orgA = org!.id;
      datasetA = dataset!.id;
      userA = user!.id;
    } else {
      orgB = org!.id;
      datasetB = dataset!.id;
      userB = user!.id;
    }
  }

  await upsertDefaults(userA, dbAdmin);
  await upsertDefaults(userB, dbAdmin);
  await setCadence(userB, 'off', dbAdmin);
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('getCachedSummary', () => {
  it('returns the dashboard summary for its own org and dataset', async () => {
    const found = await getCachedSummary(orgA, datasetA, dbAdmin);

    expect(found).toBeDefined();
    expect(found!.content).toBe('dashboard summary for a');
  });

  // Drop eq(audience) and the digest summary for the same org and dataset
  // becomes a valid answer, so this pins the one that comes back.
  it('never serves a digest summary as the dashboard one', async () => {
    const found = await getCachedSummary(orgA, datasetA, dbAdmin);
    expect(found!.audience).toBe('dashboard');
    expect(found!.content).not.toContain('digest');
  });

  // Drop eq(orgId) and org B's row is a candidate.
  it('does not return another org summary', async () => {
    const found = await getCachedSummary(orgA, datasetB, dbAdmin);
    expect(found).toBeUndefined();
  });

  // Drop isNull(staleAt) and an invalidated summary keeps being served after an
  // upload that was supposed to retire it.
  it('does not return a summary that has been marked stale', async () => {
    // markStale is (orgId, client, datasetId), not (orgId, datasetId, client).
    await markStale(orgA, dbAdmin, datasetA);

    expect(await getCachedSummary(orgA, datasetA, dbAdmin)).toBeUndefined();
  });
});

describe('org lookups', () => {
  it('finds by id and by slug, and not by another org', async () => {
    expect((await findOrgById(orgA, dbAdmin))!.id).toBe(orgA);
    expect((await findOrgBySlug(`sum-b-${suffix}`))!.id).toBe(orgB);
    expect(await findOrgById(999_999_999, dbAdmin)).toBeUndefined();
  });
});

describe('digest preferences are per user', () => {
  // userB was set to cadence 'off'. Drop eq(userId) and userA's lookup can
  // return it, which is one user reading another's unsubscribe state.
  it('returns the requesting user preferences, not another user', async () => {
    const a = await getByUserId(userA, dbAdmin);
    const b = await getByUserId(userB, dbAdmin);

    expect(a!.userId).toBe(userA);
    expect(b!.userId).toBe(userB);
    expect(a!.cadence).not.toBe('off');
    expect(b!.cadence).toBe('off');
  });
});
