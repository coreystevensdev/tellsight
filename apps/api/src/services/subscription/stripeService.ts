import Stripe from 'stripe';

import { env } from '../../config.js';
import { ExternalServiceError } from '../../lib/appError.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { subscriptionsQueries } from '../../db/queries/index.js';
import { logger } from '../../lib/logger.js';

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });
  }
  return _stripe;
}

export async function createCheckoutSession(
  orgId: number,
  userId: number,
  client?: typeof db | DbTransaction,
) {
  const existing = await subscriptionsQueries.getSubscriptionByOrgId(orgId, client);
  const customerParam = existing?.stripeCustomerId
    ? { customer: existing.stripeCustomerId }
    : {};

  try {
    const session = await getStripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${env.APP_URL}/billing?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_URL}/billing?canceled=true`,
      metadata: { orgId: String(orgId), userId: String(userId) },
      ...customerParam,
    });

    logger.info({ orgId, sessionId: session.id }, 'Stripe checkout session created');
    return { checkoutUrl: session.url };
  } catch (err) {
    logger.error({ orgId, err }, 'Stripe checkout session creation failed');
    throw new ExternalServiceError('Stripe', err);
  }
}

export async function createPortalSession(stripeCustomerId: string) {
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${env.APP_URL}/billing`,
    });

    return { portalUrl: session.url };
  } catch (err) {
    logger.error({ stripeCustomerId, err }, 'Stripe portal session creation failed');
    throw new ExternalServiceError('Stripe', err);
  }
}

// re-export for webhook route signature verification
export { getStripe };
