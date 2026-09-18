import { PRO_PRICE_CENTS } from 'shared/constants';

import { cachedHealth } from '../../lib/cachedHealth.js';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { getStripe } from './stripeService.js';

const TIMEOUT_MS = 5_000;

export interface StripeHealth {
  status: 'ok' | 'error' | 'unknown';
  latencyMs: number;
  livemode?: boolean;
  detail?: string;
}

/**
 * Asks Stripe whether the configured billing settings are ones it recognises.
 *
 * config.ts checks the shape of STRIPE_SECRET_KEY, not whether it works, and it
 * says nothing at all about the other two Stripe settings. Those have to agree:
 * the key, the price id and the webhook secret are each scoped to one Stripe
 * mode, so moving a deployment between modes means moving all three. Moving one
 * or two is the failure this catches.
 *
 * The key is checked first, since a price lookup against a key Stripe rejects
 * tells you nothing. A balance retrieve is the cheapest authenticated read Stripe
 * offers and changes nothing.
 *
 * The price is also checked against what the app says Pro costs. Stripe holds the
 * amount customers are charged and PRO_PRICE_CENTS holds the amount they are shown,
 * and nothing but this makes them agree: they drifted for months, with the upgrade
 * button promising $29 while checkout charged $29.99.
 *
 * The webhook secret is the one leg with no read to verify it against, and it is
 * also the worst to get wrong: checkout succeeds and activation never happens.
 */
/** Uncached. Exported so the probe's own behaviour can be tested without a
 *  module-level cache answering for it; routes should use checkStripeHealth. */
export async function probeStripeHealth(): Promise<StripeHealth> {
  const started = Date.now();

  try {
    const stripe = getStripe();
    const balance = await stripe.balance.retrieve({}, { timeout: TIMEOUT_MS });
    const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID, {}, { timeout: TIMEOUT_MS });
    const latencyMs = Date.now() - started;

    if (price.unit_amount !== PRO_PRICE_CENTS) {
      return {
        status: 'error',
        latencyMs,
        livemode: balance.livemode,
        detail: `Stripe charges ${price.unit_amount} but the app shows ${PRO_PRICE_CENTS}`,
      };
    }

    return { status: 'ok', latencyMs, livemode: balance.livemode };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const type = (err as { type?: string }).type;
    const code = (err as { statusCode?: number }).statusCode;

    // A 401 is the key being wrong, which no retry fixes and which is worth
    // reporting as broken. A timeout or a 5xx is Stripe having a bad minute, and
    // calling that an error would make this endpoint report our billing as down
    // every time their API hiccups.
    if (type === 'StripeAuthenticationError' || code === 401) {
      return {
        status: 'error',
        latencyMs,
        detail: 'Stripe rejected the configured API key',
      };
    }

    // The price lookup is the only call here that names an id, so a 404 is
    // STRIPE_PRICE_ID pointing at something this key cannot see. That is what a
    // half-finished mode switch looks like: the key moved and the price did not.
    if (code === 404) {
      return {
        status: 'error',
        latencyMs,
        detail: 'STRIPE_PRICE_ID does not exist for this API key',
      };
    }

    return { status: 'unknown', latencyMs, detail: 'Stripe unreachable, key not verified' };
  }
}

// Five minutes, against a container healthcheck that curls /health every thirty
// seconds. Two Stripe calls a probe at that rate is 5,760 a day to answer a
// question whose answer changes when someone rotates a key. A deploy restarts
// the process and empties this, so the post-deploy poll and the boot log both
// see a fresh result.
const HEALTH_TTL_MS = 5 * 60 * 1000;

export const checkStripeHealth = cachedHealth(HEALTH_TTL_MS, probeStripeHealth);

/**
 * Runs once at boot so a rejected key is visible without waiting for someone to
 * reach checkout. Never throws: billing being misconfigured should not stop the
 * dashboard, the digests or the connectors from serving.
 */
export async function logStripeKeyStatus(): Promise<void> {
  // The uncached probe: boot wants a fresh answer, and there is nothing to
  // spare anyway since the cache is empty this early.
  const health = await probeStripeHealth();

  if (health.status === 'error') {
    logger.error(
      { latencyMs: health.latencyMs, detail: health.detail },
      'Stripe billing is misconfigured',
    );
    return;
  }

  if (health.status === 'unknown') {
    logger.warn({ latencyMs: health.latencyMs }, 'Could not verify the Stripe settings at boot');
    return;
  }

  logger.info(
    { latencyMs: health.latencyMs, livemode: health.livemode },
    'Stripe key and price verified',
  );
}
