import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

import { env } from '../../config.js';

// Single queue, unlike alerts/digest's three-stage shape: expiry is a flat
// sweep with no per-org fan-out (expireCorrections filters by expiresAt
// across all orgs in one query), so there's nothing to route by job name.

export const QUEUE_EXPIRE = 'stat-corrections-expire';
export const JOB_EXPIRE = 'stat-corrections-expire';

export function connectionOptions(): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

let expireQueue: Queue | null = null;

export function getExpireQueue(): Queue {
  if (!expireQueue) {
    expireQueue = new Queue(QUEUE_EXPIRE, { connection: connectionOptions() });
  }
  return expireQueue;
}

// Test-only: drop the singleton so suite teardown can re-init with fresh mocks.
export function resetQueue(): void {
  expireQueue = null;
}

export async function closeQueue(): Promise<void> {
  if (expireQueue) await expireQueue.close();
  resetQueue();
}
