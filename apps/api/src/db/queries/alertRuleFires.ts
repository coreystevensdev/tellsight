import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { AlertRuleKind } from 'shared/schemas';
import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { alertRuleFires } from '../schema.js';

export type AlertRuleFireRow = typeof alertRuleFires.$inferSelect;

type AdminClient = typeof dbAdmin | DbTransaction;

const SEVEN_DAYS_AGO = sql`now() - interval '7 days'`;

// Namespaces the org-quota advisory lock so it can't collide with an unrelated
// single-key lock elsewhere (e.g. db/migrate.ts's MIGRATION_LOCK_ID, or a
// future feature that also happens to lock by orgId).
const QUOTA_LOCK_NAMESPACE = 771;

export interface CreateFireInput {
  orgId: number;
  ruleId: number;
  ruleKind: AlertRuleKind;
  trigger: string;
  thresholdValue: unknown;
  currentValue: number;
  band: number;
}

// No default client, same as alertRules.getEnabledByOrgIdsForEvaluation: this
// always runs from the evaluator's cross-org worker context, never inside a
// single tenant's RLS session.
export async function create(
  input: CreateFireInput,
  client: AdminClient,
): Promise<AlertRuleFireRow> {
  const [row] = await client
    .insert(alertRuleFires)
    .values({
      orgId: input.orgId,
      ruleId: input.ruleId,
      ruleKind: input.ruleKind,
      trigger: input.trigger,
      thresholdValue: input.thresholdValue,
      currentValue: input.currentValue,
      band: input.band,
    })
    .returning();
  return row!;
}

export async function getLatestByRuleId(
  ruleId: number,
  client: AdminClient,
): Promise<AlertRuleFireRow | null> {
  const [row] = await client
    .select()
    .from(alertRuleFires)
    .where(eq(alertRuleFires.ruleId, ruleId))
    .orderBy(desc(alertRuleFires.firedAt))
    .limit(1);
  return row ?? null;
}

export async function countRecentByOrgId(
  orgId: number,
  client: AdminClient,
): Promise<number> {
  const [row] = await client
    .select({ value: sql<number>`count(*)::int` })
    .from(alertRuleFires)
    .where(and(eq(alertRuleFires.orgId, orgId), gte(alertRuleFires.firedAt, SEVEN_DAYS_AGO)));
  return row?.value ?? 0;
}

/**
 * Atomic quota-checked insert. `countRecentByOrgId` + `create` as separate
 * calls is check-then-act: two evaluate-org jobs for the same org can both
 * read a count under quota before either commits, and both insert. The
 * advisory lock serializes concurrent callers on the same orgId so the
 * re-check inside the lock always sees the other transaction's write.
 * Returns null (no insert) once `quotaMax` recent fires already exist.
 */
export async function createIfUnderQuota(
  input: CreateFireInput,
  quotaMax: number,
  client: AdminClient,
): Promise<AlertRuleFireRow | null> {
  const run = async (tx: AdminClient): Promise<AlertRuleFireRow | null> => {
    // Bounds how long a stuck holder can block a same-org caller. evaluate-org
    // jobs already retry with backoff (orchestrator.ts), so failing fast here
    // is safer than tying up a worker slot indefinitely on the blocking lock.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK_NAMESPACE}, ${input.orgId})`);
    const recentCount = await countRecentByOrgId(input.orgId, tx);
    if (recentCount >= quotaMax) return null;
    return create(input, tx);
  };

  // Identity check, same idiom as orgFinancials.updateOrgFinancials: only the
  // bare dbAdmin client lacks an outer tx, a passed client is always already
  // a transaction.
  if (client === dbAdmin) {
    return dbAdmin.transaction((tx) => run(tx));
  }
  return run(client);
}
