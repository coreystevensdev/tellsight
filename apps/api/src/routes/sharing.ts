import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { generateShareLink, getSharedInsight } from '../services/sharing/index.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { createShareSchema } from 'shared/schemas';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { ValidationError } from '../lib/appError.js';

// mounted behind authMiddleware via protectedRouter
export const shareRouter = Router();

shareRouter.post('/', async (req, res: Response) => {
  const { user } = req as AuthenticatedRequest;

  const parsed = createShareSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid share parameters', parsed.error.format());
  }

  const result = await generateShareLink(
    user.org_id,
    parsed.data.datasetId,
    parseInt(user.sub, 10),
  );

  trackEvent(user.org_id, parseInt(user.sub, 10), ANALYTICS_EVENTS.SHARE_CREATED, {
    datasetId: parsed.data.datasetId,
  });

  res.status(201).json({ data: result });
});

// public router — no auth required, token hash is the access control
export const publicShareRouter = Router();

publicShareRouter.get('/shares/:token', async (req, res: Response) => {
  const { token } = req.params;
  if (!token || token.length < 16) {
    throw new ValidationError('Invalid share token');
  }

  const insight = await getSharedInsight(token);

  // viewCount tracking happens inside getSharedInsight (atomic increment).
  // SHARE_VIEWED analytics event skipped — analytics_events requires userId,
  // and public viewers are anonymous. viewCount covers this metric.

  res.json({ data: insight });
});
