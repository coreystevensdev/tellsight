import { eq } from 'drizzle-orm';

import * as userOrgsQueries from '../../db/queries/userOrgs.js';
import * as subscriptionsQueries from '../../db/queries/subscriptions.js';
import { orgs, users } from '../../db/schema.js';
import { ConflictError } from '../../lib/appError.js';
import { dbAdmin } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { getStripe } from '../subscription/stripeService.js';

export type DeletionBlocker = { orgId: number; orgName: string };

export type AccountDeletion = { deletedOrgIds: number[]; leftOrgIds: number[] };

/** Orgs the user is the last member of die with them. Orgs with other people in
 *  them outlive them, unless the user is the only owner: removing the last owner
 *  would leave members with an org nobody can bill, invite to, or delete. */
async function planOrgFate(userId: number) {
  const memberships = await userOrgsQueries.getUserOrgs(userId, dbAdmin);
  const toDelete: number[] = [];
  const toLeave: number[] = [];
  const blockers: DeletionBlocker[] = [];

  for (const membership of memberships) {
    const members = await userOrgsQueries.getOrgMembers(membership.orgId, dbAdmin);
    const others = members.filter((m) => m.userId !== userId);

    if (others.length === 0) {
      toDelete.push(membership.orgId);
    } else if (membership.role === 'owner' && !others.some((m) => m.role === 'owner')) {
      blockers.push({ orgId: membership.orgId, orgName: membership.org.name });
    } else {
      toLeave.push(membership.orgId);
    }
  }

  return { toDelete, toLeave, blockers };
}

/** Stripe has to be told before the row that names the subscription goes away.
 *  A failure here stops the deletion: a cancelled account whose subscription is
 *  still billing is worse than one that is still there, and once the row is gone
 *  nothing in the system knows which Stripe subscription to go and cancel. */
async function cancelSubscriptions(orgIds: number[]) {
  for (const orgId of orgIds) {
    const subscription = await subscriptionsQueries.getSubscriptionByOrgId(orgId, dbAdmin);
    const stripeId = subscription?.stripeSubscriptionId;
    if (!stripeId || subscription.status === 'canceled') continue;

    await getStripe().subscriptions.cancel(stripeId);
    logger.info({ orgId, stripeId }, 'Cancelled subscription for account deletion');
  }
}

/**
 * Deletes the user and every org that would be left empty behind them.
 *
 * The cascades do the work the law cares about: user_orgs, refresh and reset
 * tokens, analytics events, digest preferences and shares go with the user row,
 * while audit logs, uploaded datasets, alert rules and stat corrections keep
 * their rows and lose the name attached to them.
 *
 * That second half only holds for orgs that outlive the user. Every one of the 19
 * tables pointing at orgs cascades, audit_logs included, so an org deleted here
 * takes its own trail with it. The record that the account was deleted is written
 * against the org the caller was acting in, which is usually one of the ones going
 * away, so do not read these entries as a durable deletion log.
 */
export async function deleteAccount(userId: number): Promise<AccountDeletion> {
  const { toDelete, toLeave, blockers } = await planOrgFate(userId);

  if (blockers.length > 0) {
    throw new ConflictError(
      'Transfer ownership of your organizations before deleting your account',
      { organizations: blockers },
    );
  }

  await cancelSubscriptions(toDelete);

  await dbAdmin.transaction(async (tx) => {
    for (const orgId of toDelete) {
      await tx.delete(orgs).where(eq(orgs.id, orgId));
    }
    await tx.delete(users).where(eq(users.id, userId));
  });

  logger.info(
    { userId, deletedOrgIds: toDelete, leftOrgIds: toLeave },
    'Account deleted',
  );

  return { deletedOrgIds: toDelete, leftOrgIds: toLeave };
}
