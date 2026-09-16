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
 * The webhook secret is the one leg with no read to verify it against, and it is
 * also the worst to get wrong: checkout succeeds and activation never happens.
 */
export async function checkStripeHealth(): Promise<StripeHealth> {
  const started = Date.now();

  try {
    const stripe = getStripe();
    const balance = await stripe.balance.retrieve({}, { timeout: TIMEOUT_MS });
    await stripe.prices.retrieve(env.STRIPE_PRICE_ID, {}, { timeout: TIMEOUT_MS });

    return { status: 'ok', latencyMs: Date.now() - started, livemode: balance.livemode };
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

/**
 * Runs once at boot so a rejected key is visible without waiting for someone to
 * reach checkout. Never throws: billing being misconfigured should not stop the
 * dashboard, the digests or the connectors from serving.
 */
export async function logStripeKeyStatus(): Promise<void> {
  const health = await checkStripeHealth();

  if (health.status === 'error') {
    logger.error(
      { latencyMs: health.latencyMs, detail: health.detail },
      'Stripe billing settings rejected, checkout and upgrades will fail',
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
