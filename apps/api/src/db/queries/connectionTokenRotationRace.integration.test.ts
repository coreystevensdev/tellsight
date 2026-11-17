import { eq, inArray } from 'drizzle-orm';
import { describe, it, expect, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, integrationConnections } from '../schema.js';
import { upsert, updateTokensIfUnchanged } from './integrationConnections.js';

// updateTokensIfUnchanged is what keeps two concurrent refreshes of one
// connection from clobbering each other. createQbClient already collapses
// concurrent 401s inside one client instance, but a client is built per sync, so
// a scheduled run and a manual run hold separate instances and refresh
// independently (DW-283). On a provider whose refresh tokens rotate, the loser
// writing its pair over the winner's leaves a token nobody can use.
//
// The guarantee is the `encrypted_refresh_token` equality in the WHERE clause,
// so no unit test can see it: they mock the query and assert the boolean comes
// back out. Deleting the predicate leaves every one of them green, which is the
// same reason refreshTokenRotationRace.integration.test.ts exists for the
// session-token version of this.

const createdOrgs: number[] = [];

afterAll(async () => {
  if (createdOrgs.length) await dbAdmin.delete(orgs).where(inArray(orgs.id, createdOrgs));
});

async function seedConnection(label: string) {
  const suffix = `${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: `Rotation ${suffix}`, slug: `rotation-${suffix}` })
    .returning({ id: orgs.id });
  createdOrgs.push(org!.id);

  const connection = await upsert(
    {
      orgId: org!.id,
      provider: 'quickbooks',
      providerTenantId: `realm-${suffix}`,
      encryptedAccessToken: 'enc:access-v1',
      encryptedRefreshToken: 'enc:refresh-v1',
      accessTokenExpiresAt: new Date('2026-11-17T09:00:00Z'),
    },
    dbAdmin,
  );
  return connection;
}

async function storedTokens(id: number) {
  const [row] = await dbAdmin
    .select({
      access: integrationConnections.encryptedAccessToken,
      refresh: integrationConnections.encryptedRefreshToken,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));
  return row!;
}

describe('updateTokensIfUnchanged against real Postgres', () => {
  it('writes when the stored refresh token is the one the caller started from', async () => {
    const connection = await seedConnection('wins');

    const won = await updateTokensIfUnchanged(
      connection.id,
      'enc:refresh-v1',
      'enc:access-v2',
      'enc:refresh-v2',
      new Date('2026-11-17T10:00:00Z'),
      dbAdmin,
    );

    expect(won).toBe(true);
    expect(await storedTokens(connection.id)).toEqual({
      access: 'enc:access-v2',
      refresh: 'enc:refresh-v2',
    });
  });

  it('refuses, and changes nothing, when another refresh rotated first', async () => {
    const connection = await seedConnection('loses');

    // The winner rotates to v2.
    expect(
      await updateTokensIfUnchanged(
        connection.id,
        'enc:refresh-v1',
        'enc:access-v2',
        'enc:refresh-v2',
        new Date('2026-11-17T10:00:00Z'),
        dbAdmin,
      ),
    ).toBe(true);

    // The loser is still holding v1 and must not overwrite v2 with its own v3.
    const won = await updateTokensIfUnchanged(
      connection.id,
      'enc:refresh-v1',
      'enc:access-v3',
      'enc:refresh-v3',
      new Date('2026-11-17T11:00:00Z'),
      dbAdmin,
    );

    expect(won).toBe(false);
    expect(await storedTokens(connection.id)).toEqual({
      access: 'enc:access-v2',
      refresh: 'enc:refresh-v2',
    });
  });

  // Two callers racing for real, rather than in sequence. Exactly one may win,
  // because the predicate is evaluated against the committed row.
  it('lets exactly one of two concurrent callers win', async () => {
    const connection = await seedConnection('race');

    const results = await Promise.all([
      updateTokensIfUnchanged(
        connection.id,
        'enc:refresh-v1',
        'enc:access-a',
        'enc:refresh-a',
        new Date('2026-11-17T10:00:00Z'),
        dbAdmin,
      ),
      updateTokensIfUnchanged(
        connection.id,
        'enc:refresh-v1',
        'enc:access-b',
        'enc:refresh-b',
        new Date('2026-11-17T10:00:00Z'),
        dbAdmin,
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await storedTokens(connection.id);
    expect(['enc:refresh-a', 'enc:refresh-b']).toContain(after.refresh);
  });
});
