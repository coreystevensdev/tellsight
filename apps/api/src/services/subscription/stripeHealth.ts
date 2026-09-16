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
 * Asks Stripe whether the configured key is one it recognises.
 *
 * config.ts already rejects an sk_test_ key in production, and its message says
 * why: a test key there silently ships a broken payment flow. But it checks the
 * prefix, not the key. Production ran for weeks on an sk_live_ value that Stripe
 * answers 401 to, which is the same broken flow the prefix rule exists to stop.
 *
 * A retrieve on the balance is the cheapest authenticated read Stripe offers and
 * changes nothing.
 */
export async function checkStripeHealth(): Promise<StripeHealth> {
  const started = Date.now();

  try {
    const balance = await getStripe().balance.retrieve({}, { timeout: TIMEOUT_MS });
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
      'Stripe key rejected, checkout and upgrades will fail',
    );
    return;
  }

  if (health.status === 'unknown') {
    logger.warn({ latencyMs: health.latencyMs }, 'Could not verify the Stripe key at boot');
    return;
  }

  logger.info({ latencyMs: health.latencyMs, livemode: health.livemode }, 'Stripe key verified');
}
