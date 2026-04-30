import Redis from 'ioredis';
import { env } from '../config.js';
import { logger } from './logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  enableOfflineQueue: false, // fail fast, affects all redis consumers (rate limiter, cache, sessions)
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redis.on('connect', () => {
  logger.info({}, 'Redis connected');
});

export async function checkRedisHealth(): Promise<{ status: 'ok' | 'error'; latencyMs: number }> {
  const start = Date.now();
  try {
    await redis.ping();
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start };
  }
}
