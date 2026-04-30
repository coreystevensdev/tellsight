import { desc, eq, sql } from 'drizzle-orm';
import { orgFinancialsSchema } from 'shared/schemas';
import type { OrgFinancials } from 'shared/types';
import { db, type DbTransaction } from '../../lib/db.js';
import { cashBalanceSnapshots, orgs } from '../schema.js';

export interface CashBalanceSnapshot {
  balance: number;
  asOfDate: string;
}

/**
 * Reads financial baseline fields from orgs.businessProfile JSONB.
 * Returns null if the org has no profile yet (new accounts).
 */
export async function getOrgFinancials(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<OrgFinancials | null> {
  const org = await client.query.orgs.findFirst({
    where: eq(orgs.id, orgId),
  });
  if (!org?.businessProfile) return null;

  const result = orgFinancialsSchema.safeParse(org.businessProfile);
  return result.success ? result.data : null;
}

/**
 * Merges financial fields into existing businessProfile JSONB using the Postgres
 * `||` operator, existing onboarding fields (businessType, revenueRange, etc.)
 * survive. When cashOnHand changes, atomically appends a snapshot for runway-over-time.
 *
 * The merge + snapshot insert must share a transaction, a split would corrupt history.
 */
export async function updateOrgFinancials(
  orgId: number,
  updates: Partial<OrgFinancials>,
  client: typeof db | DbTransaction = db,
): Promise<OrgFinancials | null> {
  const validated = orgFinancialsSchema.partial().parse(updates);

  // Early-return on empty payload so we don't issue a no-op UPDATE round trip.
  if (Object.keys(validated).length === 0) {
    return getOrgFinancials(orgId, client);
  }

  const hasCashUpdate = validated.cashOnHand != null;

  const run = async (tx: typeof db | DbTransaction) => {
    await tx
      .update(orgs)
      .set({
        businessProfile: sql`COALESCE(${orgs.businessProfile}, '{}'::jsonb) || ${JSON.stringify(validated)}::jsonb`,
      })
      .where(eq(orgs.id, orgId));

    if (hasCashUpdate) {
      const asOfDate = validated.cashAsOfDate ? new Date(validated.cashAsOfDate) : new Date();
      await tx.insert(cashBalanceSnapshots).values({
        orgId,
        balance: validated.cashOnHand!.toFixed(2),
        asOfDate,
      });
    }

    return getOrgFinancials(orgId, tx);
  };

  // Identity check, only the global `db` lacks an outer tx context. A passed
  // client is always a transaction (either a withRlsContext wrapper or an
  // explicit db.transaction from a caller). Duck-typing (`'rollback' in client`)
  // diverges from the codebase's convention and misses cases where Drizzle's
  // tx object is further wrapped.
  if (client === db) {
    return db.transaction((tx) => run(tx));
  }
  return run(client);
}

/**
 * Returns recent cash balance snapshots ordered newest-first. Used for runway-over-time
 * charts and the /settings/financials history view.
 */
export async function getCashBalanceHistory(
  orgId: number,
  limit = 12,
  client: typeof db | DbTransaction = db,
): Promise<CashBalanceSnapshot[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 60);
  const rows = await client
    .select({
      balance: cashBalanceSnapshots.balance,
      asOfDate: cashBalanceSnapshots.asOfDate,
    })
    .from(cashBalanceSnapshots)
    .where(eq(cashBalanceSnapshots.orgId, orgId))
    .orderBy(desc(cashBalanceSnapshots.asOfDate))
    .limit(bounded);

  return rows.map((r) => ({
    balance: Number(r.balance),
    asOfDate: r.asOfDate.toISOString(),
  }));
}
