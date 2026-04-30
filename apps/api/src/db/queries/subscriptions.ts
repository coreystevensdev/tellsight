import { and, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';

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
      .limit(1);
    return result.length > 0 ? 'pro' : 'free';
  } catch {
    // table may not exist yet pre-Epic 5, all users are free
    return 'free';
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
) {
  await client
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
    );
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
