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

export async function updateLastSyncedAt(
  id: number,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(integrationConnections)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
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
