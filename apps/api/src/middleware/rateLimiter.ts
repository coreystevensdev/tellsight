import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { rateLimitHits } from '../lib/metrics.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { RATE_LIMITS } from 'shared/constants';

// in-memory fallbacks — same limits, per-process only
const authFallback = new RateLimiterMemory({
  points: RATE_LIMITS.auth.max,
  duration: RATE_LIMITS.auth.windowMs / 1000,
});

const aiFallback = new RateLimiterMemory({
  points: RATE_LIMITS.ai.max,
  duration: RATE_LIMITS.ai.windowMs / 1000,
});

const publicFallback = new RateLimiterMemory({
  points: RATE_LIMITS.public.max,
  duration: RATE_LIMITS.public.windowMs / 1000,
});

const authLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl_auth',
  points: RATE_LIMITS.auth.max,
  duration: RATE_LIMITS.auth.windowMs / 1000,
  insuranceLimiter: authFallback,
});

const aiLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl_ai',
  points: RATE_LIMITS.ai.max,
  duration: RATE_LIMITS.ai.windowMs / 1000,
  insuranceLimiter: aiFallback,
});

const publicLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl_public',
  points: RATE_LIMITS.public.max,
  duration: RATE_LIMITS.public.windowMs / 1000,
  insuranceLimiter: publicFallback,
});

function sendRateLimited(res: Response, rlRes: RateLimiterRes) {
  const retryAfter = Math.ceil(rlRes.msBeforeNext / 1000);
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests' },
  });
}

export function rateLimitAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  authLimiter
    .consume(key)
    .then(() => next())
    .catch((rlRes) => {
      if (rlRes instanceof RateLimiterRes) {
        rateLimitHits.inc({ limiter: 'auth' });
        logger.warn({ ip: key, path: req.path }, 'Auth rate limit exceeded');
        return sendRateLimited(res, rlRes);
      }
      // unexpected error — fail open
      logger.warn({ err: rlRes }, 'Rate limiter error — failing open');
      next();
    });
}

export function rateLimitAi(req: Request, res: Response, next: NextFunction) {
  const key = req.user?.sub ?? req.ip ?? 'unknown';

  if (!req.user?.sub) {
    logger.warn({ path: req.path }, 'AI rate limiter missing user — falling back to IP');
  }

  aiLimiter
    .consume(key)
    .then(() => next())
    .catch((rlRes) => {
      if (rlRes instanceof RateLimiterRes) {
        rateLimitHits.inc({ limiter: 'ai' });
        logger.warn({ userId: key, path: req.path }, 'AI rate limit exceeded');
        return sendRateLimited(res, rlRes);
      }
      logger.warn({ err: rlRes }, 'Rate limiter error — failing open');
      next();
    });
}

export function rateLimitPublic(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  publicLimiter
    .consume(key)
    .then(() => next())
    .catch((rlRes) => {
      if (rlRes instanceof RateLimiterRes) {
        rateLimitHits.inc({ limiter: 'public' });
        logger.warn({ ip: key, path: req.path }, 'Public rate limit exceeded');
        return sendRateLimited(res, rlRes);
      }
      logger.warn({ err: rlRes }, 'Rate limiter error — failing open');
      next();
    });
}
