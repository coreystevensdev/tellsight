import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { orgs, users } from '../schema.js';
import { createDataset } from './datasets.js';
import { addMember } from './userOrgs.js';
import { getOrgDetail } from './admin.js';
import { getLastDigest, getTrailingDigests, saveDigestHistory } from './digestHistory.js';
import { dbAdmin } from '../../lib/db.js';

// The last two query modules whose unit tests mock the Drizzle chain and assert
// only that a query ran. Both are org scoped and neither had that scoping
// checked against a database.
//
// getLastDigest carries a second predicate worth pinning on its own:
// excludeWeekStart stops a retried send job reading back the row it just wrote
// as "last week's digest", which would make the longitudinal comparison compare
// a week against itself.
//
// Two orgs throughout, each with the same shapes of data, because a scoping test
// against a single-org fixture passes whether or not the predicate is there.

const suffix = `adm-${process.pid}`;
const createdOrgs: number[] = [];
const createdUsers: number[] = [];

let orgA: number;
let orgB: number;

const WEEK_1 = new Date('2026-01-05');
const WEEK_2 = new Date('2026-01-12');

async function seedDigest(orgId: number, weekStart: Date, subject: string) {
  await saveDigestHistory(
    {
      orgId,
      datasetId: null,
      summaryId: null,
      weekStart,
      subjectLine: subject,
      stateSentence: subject,
      valence: 'neutral',
      keyStats: [],
      milestones: [],
      sentAt: new Date(),
    },
    dbAdmin,
  );
}

beforeAll(async () => {
  for (const label of ['a', 'b']) {
    const [org] = await dbAdmin
      .insert(orgs)
      .values({ name: `adm ${label} ${suffix}`, slug: `adm-${label}-${suffix}` })
      .returning();
    createdOrgs.push(org!.id);

    const [user] = await dbAdmin
      .insert(users)
      .values({ email: `adm-${label}-${suffix}@example.com`, name: `member ${label}` })
      .returning();
    createdUsers.push(user!.id);

    await addMember(org!.id, user!.id, 'owner', dbAdmin);
    await createDataset(org!.id, { name: `adm-${label}.csv` }, dbAdmin);

    await seedDigest(org!.id, WEEK_1, `week1-${label}`);
    await seedDigest(org!.id, WEEK_2, `week2-${label}`);

    if (label === 'a') {
      orgA = org!.id;
    } else {
      orgB = org!.id;
    }
  }
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('digestHistory stays inside its org', () => {
  it('returns its own most recent digest', async () => {
    const last = await getLastDigest(orgA, undefined, dbAdmin);

    expect(last).toBeDefined();
    expect(last!.orgId).toBe(orgA);
    expect(last!.subjectLine).toBe('week2-a');
  });

  // Both orgs have a week-2 row, so dropping eq(orgId) makes org B's a candidate
  // and the orderBy alone will not keep them apart.
  it('never returns another org digest', async () => {
    const last = await getLastDigest(orgB, undefined, dbAdmin);
    expect(last!.orgId).toBe(orgB);
    expect(last!.subjectLine).toBe('week2-b');
  });

  // The retry guard. Without lt(weekStart, excludeWeekStart) a re-enqueued job
  // reads back the row it just saved and compares the week against itself.
  it('skips the excluded week so a retry does not read its own row', async () => {
    const prior = await getLastDigest(orgA, WEEK_2, dbAdmin);

    expect(prior).toBeDefined();
    expect(prior!.subjectLine).toBe('week1-a');
  });

  it('returns only its own trailing digests, newest first', async () => {
    const rows = await getTrailingDigests(orgA, 10, dbAdmin);

    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.orgId === orgA)).toBe(true);
    expect(rows.map((r) => r.subjectLine)).toEqual(['week2-a', 'week1-a']);
  });
});

describe('admin org detail stays inside the requested org', () => {
  it('returns the org with its own members and datasets', async () => {
    const detail = await getOrgDetail(orgA);

    // getOrgDetail is nullable when the org is not found, so this is the
    // assertion that the lookup itself worked, not a type-checker appeasement.
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(orgA);
    expect(detail!.members).toHaveLength(1);
    expect(detail!.members[0]!.email).toBe(`adm-a-${suffix}@example.com`);
    expect(detail!.datasets).toHaveLength(1);
    expect(detail!.datasets[0]!.name).toBe('adm-a.csv');
  });

  // Four separate org predicates in this function. Dropping any of them pulls
  // the other org's members, datasets or subscription into this view, and both
  // orgs are seeded so there is something wrong to pull.
  it('does not leak the other org members or datasets', async () => {
    const detail = await getOrgDetail(orgB);

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(orgB);
    expect(detail!.members.map((m) => m.email)).toEqual([`adm-b-${suffix}@example.com`]);
    expect(detail!.datasets.map((d) => d.name)).toEqual(['adm-b.csv']);
  });
});
