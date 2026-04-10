import { Router, type Response } from 'express';

import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { subscriptionsQueries } from '../db/queries/index.js';
import { createCheckoutSession, createPortalSession } from '../services/subscription/index.js';
import { withRlsContext } from '../lib/rls.js';
import { AppError } from '../lib/appError.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.get('/tier', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const tier = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    subscriptionsQueries.getActiveTier(user.org_id, tx),
  );
  res.json({ data: { tier } });
});

subscriptionsRouter.post('/checkout', roleGuard('owner'), async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const result = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    createCheckoutSession(user.org_id, Number(user.sub), tx),
  );
  res.json({ data: result });
});

subscriptionsRouter.post('/portal', roleGuard('owner'), async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;
  const subscription = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    subscriptionsQueries.getSubscriptionByOrgId(user.org_id, tx),
  );

  if (!subscription?.stripeCustomerId) {
    throw new AppError('No active subscription found', 'NO_SUBSCRIPTION', 404);
  }

  const result = await createPortalSession(subscription.stripeCustomerId);
  res.json({ data: result });
});
