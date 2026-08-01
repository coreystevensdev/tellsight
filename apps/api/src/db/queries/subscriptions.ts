import { and, desc, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';

import type { SubscriptionTier } from 'shared/types';

import { db, type DbTransaction } from '../../lib/db.js';
import { subscriptions } from '../schema.js';

export type { SubscriptionTier };

export async function getActiveTier(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<SubscriptionTier> {
  try {
    const now = new Date();
    const result = await client
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          or(
            // active: period still valid OR period not yet populated (just-completed checkout)
            and(eq(subscriptions.status, 'active'), or(gt(subscriptions.currentPeriodEnd, now), isNull(subscriptions.currentPeriodEnd))),
            // canceled but within paid period, access continues until currentPeriodEnd
            and(eq(subscriptions.status, 'canceled'), isNotNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, now)),
          ),
        ),
      )
      .orderBy(desc(subscriptions.id))
      .limit(1);
    return result.length > 0 ? 'pro' : 'free';
  } catch {
    // subscriptions table may not exist in fresh installs; treat as free
    return 'free';
  }
}

// Same active-row lookup as getActiveTier, returns the flag off that row
// instead of deriving a tier. Defaults false on no active row or query
// failure -- an entitlement gate should never fail open.
export async function getAgentEnabled(
  orgId: number,
  client: typeof db | DbTransaction = db,
): Promise<boolean> {
  try {
    const now = new Date();
    const result = await client
      .select({ agentEnabled: subscriptions.agentEnabled })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.orgId, orgId),
          or(
            and(eq(subscriptions.status, 'active'), or(gt(subscriptions.currentPeriodEnd, now), isNull(subscriptions.currentPeriodEnd))),
            and(eq(subscriptions.status, 'canceled'), isNotNull(subscriptions.currentPeriodEnd), gt(subscriptions.currentPeriodEnd, now)),
          ),
        ),
      )
      .orderBy(desc(subscriptions.id))
      .limit(1);
    return result[0]?.agentEnabled ?? false;
  } catch {
    return false;
  }
}

interface UpsertSubscriptionParams {
  orgId: number;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  status: string;
  plan: string;
  currentPeriodEnd: Date | null;
}

export async function upsertSubscription(
  params: UpsertSubscriptionParams,
  client: typeof db | DbTransaction = db,
) {
  const [result] = await client
    .insert(subscriptions)
    .values({
      orgId: params.orgId,
      stripeCustomerId: params.stripeCustomerId,
      stripeSubscriptionId: params.stripeSubscriptionId,
      status: params.status,
      plan: params.plan,
      currentPeriodEnd: params.currentPeriodEnd,
    })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: {
        stripeCustomerId: params.stripeCustomerId,
        stripeSubscriptionId: params.stripeSubscriptionId,
        status: params.status,
        plan: params.plan,
        currentPeriodEnd: params.currentPeriodEnd,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

export async function updateSubscriptionPeriod(
  stripeSubscriptionId: string,
  currentPeriodEnd: Date,
  client: typeof db | DbTransaction = db,
) {
  const result = await client
    .update(subscriptions)
    .set({ currentPeriodEnd, updatedAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .returning({ id: subscriptions.id });
  return result.length;
}

export async function updateSubscriptionStatus(
  stripeSubscriptionId: string,
  status: string,
  currentPeriodEnd?: Date,
  client: typeof db | DbTransaction = db,
): Promise<number> {
  const result = await client
    .update(subscriptions)
    .set({
      status,
      ...(currentPeriodEnd && { currentPeriodEnd }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId),
        // idempotent, replay is a no-op when already in target status
        ne(subscriptions.status, status),
      ),
    )
    .returning({ id: subscriptions.id });
  return result.length;
}

// Upsert, not a bare update: most orgs have no subscriptions row at all
// (one is only created by upsertSubscription on Stripe checkout), and the
// beta-era manual toggle this backs needs to grant Agent tier to orgs that
// never went through Pro checkout. On enable, both the insert and the
// conflict branch force status='active'/plan='pro' -- getAgentEnabled and
// agentEligibility.ts's buildEligibilityQuery both require an active/pro
// row, so a pre-existing row stuck at e.g. 'inactive' (a prior disable
// through this same route, or a lapsed real subscription) would otherwise
// silently leave the org locked out despite agentEnabled=true. On disable,
// the conflict branch only ever touches agentEnabled, so an existing paying
// subscription's status/plan survive untouched -- there's nothing to grant.
export async function updateAgentEnabled(
  orgId: number,
  enabled: boolean,
  client: typeof db | DbTransaction = db,
): Promise<void> {
  await client
    .insert(subscriptions)
    .values({
      orgId,
      status: enabled ? 'active' : 'inactive',
      plan: enabled ? 'pro' : 'free',
      agentEnabled: enabled,
    })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: enabled
        ? { agentEnabled: true, status: 'active', plan: 'pro', updatedAt: new Date() }
        : { agentEnabled: false, updatedAt: new Date() },
    });
}

export async function getSubscriptionByStripeId(
  stripeSubscriptionId: string,
  client: typeof db | DbTransaction = db,
) {
  const result = await client
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return result[0] ?? null;
}

export async function getSubscriptionByOrgId(
  orgId: number,
  client: typeof db | DbTransaction = db,
) {
  const result = await client
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);
  return result[0] ?? null;
}
