import { inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { orgs, users } from '../schema.js';
import { createDataset } from './datasets.js';
import { createShare, findByTokenHash } from './shares.js';
import { dbAdmin } from '../../lib/db.js';

// /share/:token is unauthenticated. The token hash is the entire access control,
// so findByTokenHash filtering on it is the whole security property.
//
// shares.test.ts asserted `expect.objectContaining({ with: { org: true } })`,
// which says nothing about `where`. Deleting the token predicate satisfied it,
// and a mock cannot do better: it returns whatever it was told to regardless of
// the filter. Only a real server can answer "does a wrong token match anything".

const createdOrgs: number[] = [];

afterAll(async () => {
  if (createdOrgs.length) {
    await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  }
  if (createdUsers.length) {
    await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
  }
});

const createdUsers: number[] = [];

async function seedShare(slug: string, tokenHash: string) {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `share ${slug}`, slug: `share-${slug}-${process.pid}` })
    .returning();
  createdOrgs.push(org!.id);

  // A real user rather than a hardcoded id. createdBy is a foreign key, and CI
  // runs against a freshly migrated database with no rows in users, so `1`
  // passes locally on a seeded database and fails there.
  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `share-${slug}-${process.pid}@example.com`, name: 'Share Owner' })
    .returning();
  createdUsers.push(user!.id);

  const dataset = await createDataset(org!.id, { name: `${slug}.csv` }, dbAdmin);
  await createShare(
    org!.id,
    dataset!.id,
    tokenHash,
    { headline: slug },
    user!.id,
    new Date(Date.now() + 86_400_000),
    dbAdmin,
  );
  return org!.id;
}

describe('findByTokenHash against real Postgres', () => {
  it('returns the share whose token hash matches', async () => {
    const orgId = await seedShare('match', 'hash-match-aaa');

    const found = await findByTokenHash('hash-match-aaa', dbAdmin);

    expect(found).toBeDefined();
    expect(found!.orgId).toBe(orgId);
  });

  // The one that matters. With the where clause removed findFirst returns an
  // arbitrary row, so this asks for a hash that exists nowhere while at least
  // two shares are present, and requires nothing back.
  it('returns nothing for a token that matches no share', async () => {
    await seedShare('other-a', 'hash-other-aaa');
    await seedShare('other-b', 'hash-other-bbb');

    const found = await findByTokenHash('hash-that-belongs-to-nobody', dbAdmin);

    expect(found).toBeUndefined();
  });

  // A near-miss rather than a random string: a prefix would match under LIKE or
  // a truncated comparison, both of which are plausible ways to break this.
  it('does not match a token that is only a prefix of a real one', async () => {
    await seedShare('prefix', 'hash-prefix-full-value');

    expect(await findByTokenHash('hash-prefix-full', dbAdmin)).toBeUndefined();
    expect(await findByTokenHash('hash-prefix-full-value', dbAdmin)).toBeDefined();
  });
});
