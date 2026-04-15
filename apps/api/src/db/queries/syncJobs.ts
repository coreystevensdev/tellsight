import { desc, eq } from 'drizzle-orm';

import { db, type DbTransaction } from '../../lib/db.js';
import { syncJobs } from '../schema.js';

export type SyncJob = typeof syncJobs.$inferSelect;
type InsertSyncJob = typeof syncJobs.$inferInsert;

export async function create(
  data: InsertSyncJob,
  client: typeof db | DbTransaction = db,
): Promise<SyncJob> {
  const [result] = await client
    .insert(syncJobs)
    .values(data)
    .returning();
  return result!;
}

export async function update(
  id: number,
  data: Partial<Pick<SyncJob, 'status' | 'startedAt' | 'completedAt' | 'rowsSynced' | 'error'>>,
  client: typeof db | DbTransaction = db,
) {
  await client
    .update(syncJobs)
    .set(data)
    .where(eq(syncJobs.id, id));
}

export async function getRecent(
  connectionId: number,
  limit = 10,
  client: typeof db | DbTransaction = db,
): Promise<SyncJob[]> {
  return client
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.connectionId, connectionId))
    .orderBy(desc(syncJobs.createdAt))
    .limit(limit);
}
