import type { ServiceStatus, SystemHealth } from 'shared/types';

import { checkDatabaseHealth } from '../../lib/db.js';
import { checkRedisHealth } from '../../lib/redis.js';
import { checkClaudeHealth } from '../aiInterpretation/claudeClient.js';

const DEFAULT_TIMEOUT_MS = 5_000;

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  const timeout = new Promise<T>((resolve) =>
    setTimeout(() => resolve(fallback), timeoutMs),
  );
  // .catch, because a rejecting probe used to reject the Promise.all below and
  // take the whole health endpoint with it rather than just its own tile. All
  // three probes catch internally today, so this never fired; it stops that
  // discipline from being the only thing holding the endpoint up. A probe that
  // rejects reports as the same fallback a timeout does, which is a small lie
  // about why, and a better one than a 500 from the page that exists to say what
  // is broken.
  return Promise.race([fn().catch(() => fallback), timeout]);
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);

  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export async function getSystemHealth(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SystemHealth> {
  const degraded: ServiceStatus = { status: 'degraded', latencyMs: timeoutMs };

  const [database, redis, claude] = await Promise.all([
    withTimeout<ServiceStatus>(() => checkDatabaseHealth(), timeoutMs, degraded),
    withTimeout<ServiceStatus>(() => checkRedisHealth(), timeoutMs, degraded),
    withTimeout<ServiceStatus>(() => checkClaudeHealth(), timeoutMs, degraded),
  ]);

  const uptimeSeconds = process.uptime();

  return {
    services: { database, redis, claude },
    uptime: {
      seconds: Math.floor(uptimeSeconds),
      formatted: formatUptime(uptimeSeconds),
    },
    timestamp: new Date().toISOString(),
  };
}
