import type { Request, Response, NextFunction } from 'express';

import { ANALYTICS_EVENTS } from 'shared/constants';
import { subscriptionsQueries } from '../db/queries/index.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { logger } from '../lib/logger.js';

// Retained for callers that want the nominal type alias; the Request module
// augmentation in types/express.d.ts means `req.subscriptionTier` is available
// on any Request without casting.
export type TieredRequest = Request;

export async function subscriptionGate(req: Request, _res: Response, next: NextFunction) {
  const orgId = req.user?.org_id;
  const userId = req.user?.sub;

  if (!orgId) {
    req.subscriptionTier = 'free';
    next();
    return;
  }

  try {
    req.subscriptionTier = await subscriptionsQueries.getActiveTier(orgId);
  } catch (err) {
    logger.warn({ orgId, err: (err as Error).message }, 'subscription lookup failed, defaulting to free');
    req.subscriptionTier = 'free';
  }

  if (orgId && userId) {
    trackEvent(orgId, Number(userId), ANALYTICS_EVENTS.SUBSCRIPTION_STATUS_CHECKED, {
      tier: req.subscriptionTier,
      source: 'gate',
    });
  }

  next();
}
