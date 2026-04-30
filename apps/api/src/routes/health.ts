// Email health is intentionally static-ok. Vendor availability surfaces via
// send-failure logs + Sentry (AC #5, #6), not liveness probes. Probing
// resend.domains.list() here would cost a real API call every 30s per instance
// and couple liveness to an external SLA we don't control. Fail-open remains
// the posture for this endpoint.
// See Story 9.1 AC #10 for rationale.
import { Router } from 'express';
import { sql } from 'drizzle-orm';

import { db } from '../lib/db.js';
import { checkRedisHealth } from '../lib/redis.js';
import { getEmailProvider } from '../services/email/index.js';

const router = Router();

// liveness, is the process alive? Never check external deps here.
// A failed liveness probe restarts the container, so keep it trivial.
router.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

// readiness, can this instance serve traffic? Check DB + Redis.
// A failed readiness probe stops routing traffic but doesn't restart.
router.get('/health/ready', async (_req, res) => {
  const [dbHealth, redisHealth, emailHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkEmailHealth(),
  ]);

  const ready = dbHealth.status === 'ok' && redisHealth.status === 'ok';

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    services: { database: dbHealth, redis: redisHealth, email: emailHealth },
  });
});

// backward-compatible combined check (used by Docker healthcheck + E2E wait loop)
router.get('/health', async (_req, res) => {
  const [dbHealth, redisHealth, emailHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkEmailHealth(),
  ]);

  const status = dbHealth.status === 'ok' && redisHealth.status === 'ok' ? 'ok' : 'degraded';

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    services: { database: dbHealth, redis: redisHealth, email: emailHealth },
    timestamp: new Date().toISOString(),
  });
});

async function checkDatabaseHealth(): Promise<{ status: 'ok' | 'error'; latencyMs: number }> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start };
  }
}

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
