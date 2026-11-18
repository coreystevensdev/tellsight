import { and, eq } from 'drizzle-orm';

import { db, type DbTransaction } from '../../lib/db.js';
import { integrationConnections } from '../schema.js';

export type IntegrationConnection = typeof integrationConnections.$inferSelect;
type InsertConnection = typeof integrationConnections.$inferInsert;

export async function getByOrgAndProvider(
  orgId: number,
  provider: string,
  client: typeof db | DbTransaction = db,
): Promise<IntegrationConnection | null> {
  const result = await client
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.orgId, orgId),
        eq(integrationConnections.provider, provider),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

export async function getByIdAndProvider(
  id: number,
  provider: string,
  client: typeof db | DbTransaction = db,
): Promise<IntegrationConnection | null> {
  const result = await client
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.provider, provider),
      ),
    )
    .limit(1);
  return result[0] ?? null;
}

export async function upsert(
  data: InsertConnection,
  client: typeof db | DbTransaction = db,
): Promise<IntegrationConnection> {
  const [result] = await client
    .insert(integrationConnections)
    .values(data)
    .onConflictDoUpdate({
      target: [integrationConnections.orgId, integrationConnections.provider],
      set: {
        providerTenantId: data.providerTenantId,
        encryptedRefreshToken: data.encryptedRefreshToken,
        encryptedAccessToken: data.encryptedAccessToken,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        scope: data.scope,
        syncStatus: 'idle',
        syncError: null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result!;
}

export async function updateSyncStatus(
  id: number,
  syncStatus: string,
  syncError?: string | null,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(integrationConnections)
    .set({
      syncStatus,
      syncError: syncError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, id));
}

export async function updateTokens(
  id: number,
  encryptedAccessToken: string,
  encryptedRefreshToken: string,
  accessTokenExpiresAt: Date,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(integrationConnections)
    .set({
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(integrationConnections.id, id));
}

/**
 * Writes a rotated token pair only if nobody else rotated first, and reports
 * whether it won. Returns false when another refresh already moved the row.
 *
 * The compare is on the refresh token the caller actually used, which makes it a
 * version stamp rather than a guess: a provider issues one new pair per refresh
 * token, so at most one writer can match any given value. That turns the
 * property making Xero dangerous (its refresh tokens rotate and the old one dies
 * immediately) into the mechanism that keeps two concurrent refreshes from
 * clobbering each other.
 *
 * Preferred over a lock. `createQbClient` already collapses concurrent refreshes
 * inside one client instance, but a client is built per sync, so a scheduled run
 * and a manual run hold separate instances and refresh independently (DW-283).
 * Serialising that with `SELECT ... FOR UPDATE` would hold a pooled connection
 * across a 10s token call, and a Redis lock would be fail-open here, which is
 * not a lock.
 */
export async function updateTokensIfUnchanged(
  id: number,
  previousEncryptedRefreshToken: string,
  encryptedAccessToken: string,
  encryptedRefreshToken: string,
  accessTokenExpiresAt: Date,
  client: typeof db | DbTransaction = db,
): Promise<boolean> {
  const won = await client
    .update(integrationConnections)
    .set({
      encryptedAccessToken,
      encryptedRefreshToken,
      accessTokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(integrationConnections.id, id),
        eq(integrationConnections.encryptedRefreshToken, previousEncryptedRefreshToken),
      ),
    )
    .returning({ id: integrationConnections.id });

  return won.length > 0;
}

export async function updateLastSyncedAt(
  id: number,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(integrationConnections)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
}

/**
 * Stores Plaid's /transactions/sync cursor.
 *
 * Written in the same transaction as the rows it accounts for, because the
 * cursor is a claim that everything before it has been persisted. Committing it
 * separately would let a failed write leave transactions marked as seen that no
 * row exists for, and nothing later would ask for them again.
 */
export async function updateSyncCursor(
  id: number,
  cursor: string,
  client: typeof db | DbTransaction = db,
): Promise<void> {
  await client
    .update(integrationConnections)
    .set({ syncCursor: cursor, updatedAt: new Date() })
    .where(eq(integrationConnections.id, id));
}

export async function deleteByOrgAndProvider(
  orgId: number,
  provider: string,
  client: typeof db | DbTransaction = db,
) {
  const result = await client
    .delete(integrationConnections)
    .where(
      and(
        eq(integrationConnections.orgId, orgId),
        eq(integrationConnections.provider, provider),
      ),
    )
    .returning({ id: integrationConnections.id });
  return result.length;
}

export async function getAllByProvider(
  provider: string,
  client: typeof db | DbTransaction = db,
): Promise<IntegrationConnection[]> {
  return client
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.provider, provider));
}
