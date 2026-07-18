import { and, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import type { CreateAlertRuleInput, UpdateAlertRuleInput } from 'shared/schemas';
import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import { alertRules } from '../schema.js';

export type AlertRuleRow = typeof alertRules.$inferSelect;

export async function getByOrgId(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<AlertRuleRow[]> {
  return client
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.orgId, orgId), isNull(alertRules.deletedAt)))
    .orderBy(desc(alertRules.createdAt));
}

export async function getById(
  orgId: number,
  id: number,
  client: typeof db | DbTransaction = db,
): Promise<AlertRuleRow | null> {
  const [row] = await client
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId), isNull(alertRules.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function create(
  orgId: number,
  createdByUserId: number,
  input: CreateAlertRuleInput,
  client: typeof db | DbTransaction = db,
): Promise<AlertRuleRow> {
  const [row] = await client
    .insert(alertRules)
    .values({
      orgId,
      createdByUserId,
      kind: input.kind,
      threshold: input.threshold,
      enabled: input.enabled ?? true,
      muteUntil: input.muteUntil ? new Date(input.muteUntil) : null,
    })
    .returning();
  return row!;
}

// kind + threshold are always overwritten together, a PUT can't change one
// without the other or the discriminated union at the route layer would
// already have rejected the mismatched pairing. enabled and muteUntil are
// left out of the SET clause entirely when the caller omits them, so an
// edit that only changes the threshold doesn't silently re-enable a
// disabled rule or clear an active mute.
export async function update(
  orgId: number,
  id: number,
  input: UpdateAlertRuleInput,
  client: typeof db | DbTransaction = db,
): Promise<AlertRuleRow | null> {
  const [row] = await client
    .update(alertRules)
    .set({
      kind: input.kind,
      threshold: input.threshold,
      updatedAt: new Date(),
      ...(input.enabled !== undefined && { enabled: input.enabled }),
      ...(input.muteUntil !== undefined && {
        muteUntil: input.muteUntil ? new Date(input.muteUntil) : null,
      }),
    })
    .where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId), isNull(alertRules.deletedAt)))
    .returning();
  return row ?? null;
}

// Also clears muteUntil: a soft-deleted rule has no live mute window to
// preserve, and leaving a lapsed mute_until in place would fail the
// alert_rules_mute_until_future CHECK on this very UPDATE (Postgres
// re-validates the whole row, not just the columns in the SET clause).
export async function softDelete(
  orgId: number,
  id: number,
  client: typeof db | DbTransaction = db,
): Promise<AlertRuleRow | null> {
  const [row] = await client
    .update(alertRules)
    .set({ deletedAt: new Date(), updatedAt: new Date(), muteUntil: null })
    .where(and(eq(alertRules.id, id), eq(alertRules.orgId, orgId), isNull(alertRules.deletedAt)))
    .returning();
  return row ?? null;
}

type AdminClient = typeof dbAdmin | DbTransaction;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Token-authorized mute/unmute, called from the public mute route. No orgId
// scope, the HMAC-signed token itself is the authorization boundary (same
// posture as getEnabledByOrgIdsForEvaluation below), and no default client,
// this always runs from an anonymous request with no RLS session.
//
// Unconditionally resets to NOW() + 30d rather than extending from the
// existing mute_until: a re-click means "still bothering me," so the clock
// restarts from that click, it doesn't stack on top of an earlier one.
export async function muteViaToken(
  ruleId: number,
  client: AdminClient,
): Promise<AlertRuleRow | null> {
  const [row] = await client
    .update(alertRules)
    .set({ muteUntil: new Date(Date.now() + THIRTY_DAYS_MS), updatedAt: new Date() })
    .where(and(eq(alertRules.id, ruleId), isNull(alertRules.deletedAt)))
    .returning();
  return row ?? null;
}

export async function unmuteViaToken(
  ruleId: number,
  client: AdminClient,
): Promise<AlertRuleRow | null> {
  const [row] = await client
    .update(alertRules)
    .set({ muteUntil: null, updatedAt: new Date() })
    .where(and(eq(alertRules.id, ruleId), isNull(alertRules.deletedAt)))
    .returning();
  return row ?? null;
}

// Cross-org read for the Story 10.2 evaluator sweep. No default client, this
// always runs outside any single tenant's RLS context, one worker pass
// covers every org at once. Excludes muted rules, an evaluator has no reason
// to re-check a rule the owner just silenced.
export async function getEnabledByOrgIdsForEvaluation(
  orgIds: number[],
  client: AdminClient,
): Promise<AlertRuleRow[]> {
  if (orgIds.length === 0) return [];

  return client
    .select()
    .from(alertRules)
    .where(
      and(
        inArray(alertRules.orgId, orgIds),
        eq(alertRules.enabled, true),
        isNull(alertRules.deletedAt),
        or(isNull(alertRules.muteUntil), lte(alertRules.muteUntil, new Date())),
      ),
    );
}
