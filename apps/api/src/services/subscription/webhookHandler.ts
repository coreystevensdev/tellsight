import type Stripe from 'stripe';

import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';
import { subscriptionsQueries, userOrgsQueries } from '../../db/queries/index.js';
import { dbAdmin } from '../../lib/db.js';
import { trackEvent } from '../analytics/trackEvent.js';
import { auditSystem } from '../audit/auditService.js';
import { logger } from '../../lib/logger.js';

// Stripe SDK v20 moved current_period_end to SubscriptionItem,
// but the webhook event payload still includes it at the subscription level
type SubscriptionWebhookPayload = Stripe.Subscription & {
  current_period_end: number;
};

export async function handleWebhookEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as SubscriptionWebhookPayload);
      break;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as InvoiceWebhookPayload);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as SubscriptionWebhookPayload);
      break;
    default:
      logger.info({ eventType: event.type }, 'Unhandled Stripe webhook event');
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const orgId = Number(session.metadata?.orgId);
  const userId = Number(session.metadata?.userId);

  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;

  if (!orgId || !userId || !customerId || !subscriptionId) {
    logger.error({ sessionId: session.id, metadata: session.metadata, customerId, subscriptionId }, 'Missing required fields in checkout session');
    return;
  }

  await subscriptionsQueries.upsertSubscription({
    orgId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    status: 'active',
    plan: 'pro',
    currentPeriodEnd: null,
  }, dbAdmin);

  trackEvent(orgId, userId, ANALYTICS_EVENTS.SUBSCRIPTION_UPGRADED, {
    stripeSessionId: session.id,
  });

  logger.info({ orgId, userId, sessionId: session.id }, 'Checkout completed — org upgraded to Pro');
}

async function handleSubscriptionUpdated(subscription: SubscriptionWebhookPayload) {
  const stripeSubscriptionId = subscription.id;
  const orgId = Number(subscription.metadata?.orgId);
  const cancelAtPeriodEnd = subscription.cancel_at_period_end;
  const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

  if (!orgId) {
    logger.error({ subscriptionId: stripeSubscriptionId }, 'Missing orgId metadata in subscription.updated');
    return;
  }

  // always keep period dates fresh regardless of cancellation state
  const rowsUpdated = await subscriptionsQueries.updateSubscriptionPeriod(stripeSubscriptionId, currentPeriodEnd, dbAdmin);
  if (rowsUpdated === 0) {
    logger.warn({ orgId, stripeSubscriptionId }, 'subscription.updated received but no matching subscription row — possible out-of-order webhook');
  }

  if (cancelAtPeriodEnd) {
    await subscriptionsQueries.updateSubscriptionStatus(stripeSubscriptionId, 'canceled', currentPeriodEnd, dbAdmin);

    const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
    if (ownerId) {
      trackEvent(orgId, ownerId, ANALYTICS_EVENTS.SUBSCRIPTION_CANCELLED, { stripeSubscriptionId });
    } else {
      logger.warn({ orgId, stripeSubscriptionId }, 'No org owner found — skipping cancellation analytics');
    }

    // Audit: payment-state transitions drive refunds, renewals, support disputes.
    // System event (webhook origin, no request) — user-triggered from the Stripe
    // customer portal, but reaches us server-to-server. Attach ownerId when known;
    // orgId is always known from subscription metadata.
    auditSystem({
      orgId,
      userId: ownerId ?? null,
      action: AUDIT_ACTIONS.SUBSCRIPTION_CANCELLED,
      targetType: 'subscription',
      targetId: stripeSubscriptionId,
      metadata: { currentPeriodEnd: currentPeriodEnd.toISOString() },
    });

    logger.info({ orgId, stripeSubscriptionId, cancelAtPeriodEnd }, 'Subscription canceled');
  } else if (subscription.status === 'active') {
    // user reactivated before period ended
    await subscriptionsQueries.updateSubscriptionStatus(stripeSubscriptionId, 'active', currentPeriodEnd, dbAdmin);
    logger.info({ orgId, stripeSubscriptionId }, 'Subscription reactivated');
  } else if (subscription.status === 'past_due') {
    // analytics fired by handleInvoicePaymentFailed — omitted here to avoid double-counting
    await subscriptionsQueries.updateSubscriptionStatus(stripeSubscriptionId, 'past_due', currentPeriodEnd, dbAdmin);
    logger.info({ orgId, stripeSubscriptionId }, 'Subscription past_due — payment failed');
  }
}

// webhook invoice payload carries subscription as string or expanded object
type InvoiceWebhookPayload = Stripe.Invoice & {
  subscription: string | { id: string } | null;
};

async function handleInvoicePaymentFailed(invoice: InvoiceWebhookPayload) {
  const stripeSubscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id ?? null;

  if (!stripeSubscriptionId) {
    logger.warn({ invoiceId: invoice.id }, 'invoice.payment_failed without subscription — skipping');
    return;
  }

  const sub = await subscriptionsQueries.getSubscriptionByStripeId(stripeSubscriptionId, dbAdmin);
  if (!sub) {
    logger.warn({ stripeSubscriptionId }, 'invoice.payment_failed for unknown subscription — skipping');
    return;
  }

  await subscriptionsQueries.updateSubscriptionStatus(stripeSubscriptionId, 'past_due', undefined, dbAdmin);

  const ownerId = await userOrgsQueries.getOrgOwnerId(sub.orgId, dbAdmin);
  if (ownerId) {
    trackEvent(sub.orgId, ownerId, ANALYTICS_EVENTS.SUBSCRIPTION_PAYMENT_FAILED, { stripeSubscriptionId });
  } else {
    logger.warn({ orgId: sub.orgId, stripeSubscriptionId }, 'No org owner found — skipping payment failure analytics');
  }

  logger.info({ orgId: sub.orgId, stripeSubscriptionId }, 'Payment failed — subscription marked past_due');
}

async function handleSubscriptionDeleted(subscription: SubscriptionWebhookPayload) {
  const stripeSubscriptionId = subscription.id;
  const orgId = Number(subscription.metadata?.orgId);

  if (!orgId) {
    logger.error({ subscriptionId: stripeSubscriptionId }, 'Missing orgId metadata in subscription.deleted');
    return;
  }

  await subscriptionsQueries.updateSubscriptionStatus(stripeSubscriptionId, 'expired', undefined, dbAdmin);

  const ownerId = await userOrgsQueries.getOrgOwnerId(orgId, dbAdmin);
  if (ownerId) {
    trackEvent(orgId, ownerId, ANALYTICS_EVENTS.SUBSCRIPTION_EXPIRED, { stripeSubscriptionId });
  } else {
    logger.warn({ orgId, stripeSubscriptionId }, 'No org owner found — skipping expiration analytics');
  }

  logger.info({ orgId, stripeSubscriptionId }, 'Subscription deleted — marked expired');
}
