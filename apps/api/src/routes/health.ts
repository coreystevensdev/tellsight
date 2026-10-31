// Email health is intentionally static-ok. Vendor availability surfaces via
// send-failure logs + Sentry, not liveness probes. Probing resend.domains.list()
// here would cost a real API call every 30s per instance and couple liveness to
// an external SLA we don't control. Fail-open remains the posture for this endpoint.
import { Router } from 'express';

import { env } from '../config.js';
import { checkDatabaseHealth, type DbHealth } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { checkRedisHealth } from '../lib/redis.js';
import { getEmailProvider } from '../services/email/index.js';
import { checkStripeHealth } from '../services/subscription/stripeHealth.js';
import { peekClaudeHealth } from '../services/aiInterpretation/claudeClient.js';
import type { ProviderHealth } from '../services/aiInterpretation/provider.js';

const router = Router();

// Both endpoints are public, so which tables are missing goes to the log and
// stays out of the body. Logged at error so it survives someone raising the
// level mid-incident.
function reportDatabase({ missing, ...rest }: DbHealth) {
  if (missing?.length) {
    logger.error({ missing }, 'Readiness check found the schema incomplete');
  }
  return rest;
}

// Reads the cached Claude result instead of probing. Both of these handlers are
// polled by machines, not people: Route53 curls /health/ready every thirty
// seconds and the container healthcheck curls /health on its own timer. The
// Claude probe buys a one-token completion so that it can tell an exhausted
// account from a healthy one, which is the whole point of it, and letting an
// infrastructure poll trigger that turned a monitoring loop into a standing
// order for paid requests, one every five minutes forever.
//
// Memoizing already cut this down once for Stripe; see lib/cachedHealth.ts. It
// could not cut it to zero, because a cache miss still probes and the pollers
// never stop arriving. peek has no miss.
//
// The answer is no less true for being a few minutes old: a live call would
// have returned the cached number anyway for most of that window. Boot and the
// admin panel still probe for real, so nothing loses its freshness where a
// person is actually looking.
// Carries checkedAt because a peeked answer has no upper bound on its age.
// Nothing here refreshes the cache, and the only writer that does is the admin
// panel while somebody has it open, so a boot-time result can stand for the
// life of the container: credit exhausted at 14:00 on a 09:00 boot still reads
// 'ok', and a transient 'Anthropic unreachable' at boot sticks after Anthropic
// recovers. The value cannot be made fresh without buying a completion on
// every poll, which is the cost #295 removed on purpose, so the honest move is
// to publish the age and let the reader judge rather than imply a freshness
// this does not have.
function lastKnownClaudeHealth(): ProviderHealth & { checkedAt: string | null } {
  const peeked = peekClaudeHealth();
  if (peeked) {
    return { ...peeked.value, checkedAt: new Date(peeked.cachedAt).toISOString() };
  }

  return {
    status: 'degraded',
    latencyMs: 0,
    // 'degraded' means "could not determine" everywhere else in this payload,
    // which is exactly the state between process start and the boot probe
    // landing a second or two later.
    detail: 'not probed since boot',
    checkedAt: null,
  };
}

// liveness, is the process alive? Never check external deps here.
// A failed liveness probe restarts the container, so keep it trivial.
router.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

// readiness, can this instance serve traffic? Check DB + Redis.
// A failed readiness probe stops routing traffic but doesn't restart.
router.get('/health/ready', async (_req, res) => {
  const [rawDb, redisHealth, emailHealth, stripeHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkEmailHealth(),
    checkStripeHealth(),
  ]);

  const claudeHealth = lastKnownClaudeHealth();

  const dbHealth = reportDatabase(rawDb);
  const ready = dbHealth.status === 'ok' && redisHealth.status === 'ok';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    services: { database: dbHealth, redis: redisHealth, email: emailHealth, stripe: stripeHealth, claude: claudeHealth },
  });
});

// backward-compatible combined check (used by Docker healthcheck + E2E wait loop)
// Carries buildSha because this is the endpoint external tooling already
// polls. Without it, confirming what is deployed means reading the image tag
// off the instance over SSM, which only CI can do.
router.get('/health', async (_req, res) => {
  const [rawDb, redisHealth, emailHealth, stripeHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkEmailHealth(),
    checkStripeHealth(),
  ]);

  const claudeHealth = lastKnownClaudeHealth();

  const dbHealth = reportDatabase(rawDb);
  const status = dbHealth.status === 'ok' && redisHealth.status === 'ok' ? 'ok' : 'degraded';

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    buildSha: env.BUILD_SHA ?? null,
    services: { database: dbHealth, redis: redisHealth, email: emailHealth, stripe: stripeHealth, claude: claudeHealth },
    timestamp: new Date().toISOString(),
  });
});


async function checkEmailHealth(): Promise<{
  provider: string;
  status: 'ok' | 'degraded' | 'error' | 'unregistered';
  latencyMs: number;
}> {
  try {
    const provider = getEmailProvider();
    const health = await provider.checkHealth();
    return { provider: provider.name, status: health.status, latencyMs: health.latencyMs };
  } catch {
    // Provider not registered, surface rather than crash the health route.
    return { provider: 'none', status: 'unregistered', latencyMs: 0 };
  }
}

export default router;
