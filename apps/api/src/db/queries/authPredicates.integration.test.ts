import { inArray } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { orgs, refreshTokens, users } from '../schema.js';
import { createRefreshToken, findByHash } from './refreshTokens.js';
import { addMember, findMembership } from './userOrgs.js';
import { findUserByEmail, findUserByGoogleId } from './users.js';
import { dbAdmin } from '../../lib/db.js';

// These helpers decide who is who and what they may see. Their tests mock at
// db.query.<table>.findFirst and assert only that a query ran, so deleting a
// predicate leaves them green: refresh tokens would accept revoked and expired
// ones, membership in any org would satisfy a check for a specific org, and
// sign-in would resolve to whatever row came back first.
//
// A mock cannot answer any of that. It returns what it was told regardless of
// the filter, so every case here runs against real Postgres and each one is
// written so that dropping one predicate makes it fail.

const suffix = `authpred-${process.pid}`;
const createdOrgs: number[] = [];
const createdUsers: number[] = [];

let orgA: number;
let orgB: number;
let userA: number;
let userB: number;

async function makeOrg(name: string) {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `${name} ${suffix}`, slug: `${name}-${suffix}` })
    .returning();
  createdOrgs.push(org!.id);
  return org!.id;
}

async function makeUser(handle: string) {
  const [user] = await dbAdmin
    .insert(users)
    .values({
      email: `${handle}-${suffix}@example.com`,
      name: handle,
      googleId: `google-${handle}-${suffix}`,
    })
    .returning();
  createdUsers.push(user!.id);
  return user!.id;
}

beforeAll(async () => {
  orgA = await makeOrg('org-a');
  orgB = await makeOrg('org-b');
  userA = await makeUser('user-a');
  userB = await makeUser('user-b');
});

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
});

describe('refreshTokens.findByHash', () => {
  it('finds a live token', async () => {
    await createRefreshToken(
      { tokenHash: `live-${suffix}`, userId: userA, orgId: orgA, expiresAt: new Date(Date.now() + 86_400_000) },
      dbAdmin,
    );

    const found = await findByHash(`live-${suffix}`, dbAdmin);
    expect(found).toBeDefined();
    expect(found!.userId).toBe(userA);
  });

  // Drop isNull(revokedAt) and this passes: a signed-out session keeps working.
  it('rejects a revoked token', async () => {
    const token = await createRefreshToken(
      { tokenHash: `revoked-${suffix}`, userId: userA, orgId: orgA, expiresAt: new Date(Date.now() + 86_400_000) },
      dbAdmin,
    );
    await dbAdmin
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(inArray(refreshTokens.id, [token.id]));

    expect(await findByHash(`revoked-${suffix}`, dbAdmin)).toBeUndefined();
  });

  // Drop gt(expiresAt, now) and this passes: expiry stops meaning anything.
  it('rejects an expired token', async () => {
    await createRefreshToken(
      { tokenHash: `expired-${suffix}`, userId: userA, orgId: orgA, expiresAt: new Date(Date.now() - 1_000) },
      dbAdmin,
    );

    expect(await findByHash(`expired-${suffix}`, dbAdmin)).toBeUndefined();
  });

  // Drop the hash predicate and this passes, because live tokens exist above.
  it('rejects a hash that matches no token', async () => {
    expect(await findByHash(`nobody-${suffix}`, dbAdmin)).toBeUndefined();
  });
});

describe('userOrgs.findMembership', () => {
  it('finds the membership for the right pair', async () => {
    await addMember(orgA, userA, 'owner', dbAdmin);

    const found = await findMembership(orgA, userA, dbAdmin);
    expect(found).toBeDefined();
    expect(found!.role).toBe('owner');
  });

  // userA belongs to orgA, not orgB. Drop eq(orgId) and membership anywhere
  // satisfies a check for anywhere, which is the tenant boundary.
  it('does not treat membership in one org as membership in another', async () => {
    expect(await findMembership(orgB, userA, dbAdmin)).toBeUndefined();
  });

  // And the mirror: drop eq(userId) and any member of the org passes as any user.
  it('does not treat one user as another within the same org', async () => {
    expect(await findMembership(orgA, userB, dbAdmin)).toBeUndefined();
  });
});

describe('users lookups', () => {
  it('finds by the exact email and not another', async () => {
    const found = await findUserByEmail(`user-a-${suffix}@example.com`);
    expect(found).toBeDefined();
    expect(found!.id).toBe(userA);

    // Drop the predicate and this returns an arbitrary user, which is sign-in
    // resolving to whoever happens to be first.
    expect(await findUserByEmail(`nobody-${suffix}@example.com`)).toBeUndefined();
  });

  it('finds by the exact google id and not another', async () => {
    const found = await findUserByGoogleId(`google-user-b-${suffix}`);
    expect(found).toBeDefined();
    expect(found!.id).toBe(userB);

    expect(await findUserByGoogleId(`google-nobody-${suffix}`)).toBeUndefined();
  });
});
