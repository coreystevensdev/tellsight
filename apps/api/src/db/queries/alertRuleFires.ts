import { and, desc, eq, gte, sql } from 'drizzle-orm';

import type { AlertRuleKind } from 'shared/schemas';
import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { alertRuleFires } from '../schema.js';

export type AlertRuleFireRow = typeof alertRuleFires.$inferSelect;

type AdminClient = typeof dbAdmin | DbTransaction;

const SEVEN_DAYS_AGO = sql`now() - interval '7 days'`;

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
