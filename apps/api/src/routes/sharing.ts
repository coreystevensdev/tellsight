import { Router } from 'express';
import type { Response } from 'express';
import { requireUser } from '../lib/requireUser.js';
import { generateShareLink, getSharedInsight } from '../services/sharing/index.js';
import { withRlsContext } from '../lib/rls.js';
import { createShareSchema } from 'shared/schemas';
import { ValidationError } from '../lib/appError.js';

// mounted behind authMiddleware via protectedRouter
export const shareRouter = Router();

shareRouter.post('/', async (req, res: Response) => {
  const user = requireUser(req);

  const parsed = createShareSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid share parameters', parsed.error.format());
  }

  const result = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    generateShareLink(user.org_id, parsed.data.datasetId, parseInt(user.sub, 10), tx),
  );

  // share_link.created tracking moved client-side (useCreateShareLink.ts) — avoids double-counting

  res.status(201).json({ data: result });
});

// public router — no auth required, token hash is the access control
export const publicShareRouter = Router();

publicShareRouter.get('/shares/:token', async (req, res: Response) => {
  const { token } = req.params;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new ValidationError('Invalid share token');
  }

  const insight = await getSharedInsight(token);

  // viewCount tracking happens inside getSharedInsight (atomic increment).
  // SHARE_VIEWED analytics event skipped — analytics_events requires userId,
  // and public viewers are anonymous. viewCount covers this metric.

  res.json({ data: insight });
});
