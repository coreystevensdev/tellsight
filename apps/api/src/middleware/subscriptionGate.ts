import type { Request, Response, NextFunction } from 'express';

import type { AuthenticatedRequest } from './authMiddleware.js';
import type { SubscriptionTier } from 'shared/types';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { subscriptionsQueries } from '../db/queries/index.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';

export interface TieredRequest extends Request {
  subscriptionTier?: SubscriptionTier;
}

export async function subscriptionGate(req: Request, _res: Response, next: NextFunction) {
  const authedReq = req as AuthenticatedRequest;
  const tieredReq = req as TieredRequest;
  const orgId = authedReq.user?.org_id;
  const userId = authedReq.user?.sub;

  if (!orgId) {
    tieredReq.subscriptionTier = 'free';
    next();
    return;
  }

  try {
    tieredReq.subscriptionTier = await subscriptionsQueries.getActiveTier(orgId);
  } catch (err) {
    logger.warn({ orgId, err: (err as Error).message }, 'subscription lookup failed — defaulting to free');
    tieredReq.subscriptionTier = 'free';
  }

  if (orgId && userId) {
    trackEvent(orgId, Number(userId), ANALYTICS_EVENTS.SUBSCRIPTION_STATUS_CHECKED, {
      tier: tieredReq.subscriptionTier,
      source: 'gate',
    });
  }

  next();
}
