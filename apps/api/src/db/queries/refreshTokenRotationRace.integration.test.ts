import { inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, refreshTokens } from '../schema.js';
import { createRefreshToken, revokeToken } from './refreshTokens.js';

// revokeToken is what decides whether two tabs refreshing at once end up logged
// out of every device. It carries `isNull(revokedAt)` so exactly one of several
// concurrent callers can flip the column, and the losers learn they lost rather
// than each overwriting the timestamp and minting a successor of their own
// (DW-216).
//
// That guarantee is in the WHERE clause, so the unit tests cannot see it: they
// feed `mockReturning` a row or an empty array and assert it comes back out.
// Removing the predicate leaves both of them green, which is the whole reason
// this file exists.

const createdOrgs: number[] = [];
const createdUsers: number[] = [];

afterAll(async () => {
  if (createdUsers.length) await dbAdmin.delete(users).where(inArray(users.id, createdUsers));
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

async function seedToken(label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `race ${label}`, slug: `race-${label}-${suffix}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);

  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `race-${label}-${suffix}@example.com`, name: `race ${label}` })
    .returning({ id: users.id });
  createdUsers.push(user!.id);

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const token = await createRefreshToken(
    { tokenHash: `hash-${label}-${suffix}`, userId: user!.id, orgId: org!.id, expiresAt },
    dbAdmin,
  );

  return token;
}

describe('refresh token rotation race (DW-216)', () => {
  it('revokes once and reports undefined to the second caller', async () => {
    const token = await seedToken('sequential');

    const first = await revokeToken(token.id, dbAdmin);
    const second = await revokeToken(token.id, dbAdmin);

    expect(first?.id).toBe(token.id);
    expect(second).toBeUndefined();
  });

  it('picks exactly one winner when both callers revoke at once', async () => {
    const token = await seedToken('concurrent');

    // The ordering the ledger entry describes: two tabs reloading together,
    // both having read the token as live.
    const results = await Promise.all([
      revokeToken(token.id, dbAdmin),
      revokeToken(token.id, dbAdmin),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('keeps the first revocation timestamp rather than letting the loser overwrite it', async () => {
    const token = await seedToken('timestamp');

    const first = await revokeToken(token.id, dbAdmin);
    await revokeToken(token.id, dbAdmin);

    const [stored] = await dbAdmin
      .select({ revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens)
      .where(inArray(refreshTokens.id, [token.id]));

    // An unconditional UPDATE moved revoked_at every time it ran, so the
    // recorded moment was the last attempt rather than the revocation.
    expect(stored!.revokedAt?.getTime()).toBe(first!.revokedAt?.getTime());
  });
});
