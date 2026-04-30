import { sql } from 'drizzle-orm';
import { db } from './db.js';
import type { DbTransaction } from './db.js';

/**
 * Wraps DB queries in a transaction with RLS context variables set.
 * If either SET LOCAL fails, the transaction aborts, fail-closed by design.
 *
 * Uses sql.raw() because PostgreSQL SET doesn't accept $1 parameter placeholders.
 * Safe from injection: orgId is validated as finite number, isAdmin is boolean.
 */
export async function withRlsContext<T>(
  orgId: number,
  isAdmin: boolean,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  const safeOrgId = Math.trunc(orgId);
  if (!Number.isFinite(safeOrgId) || safeOrgId !== orgId) throw new Error('orgId must be a finite integer');
  if (typeof isAdmin !== 'boolean') throw new Error('isAdmin must be a boolean');

  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL app.current_org_id = '${String(safeOrgId)}'`));
    await tx.execute(sql.raw(`SET LOCAL app.is_admin = '${String(isAdmin)}'`));
    return fn(tx);
  });
}
