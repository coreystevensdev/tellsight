import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { requireUser } from '../lib/requireUser.js';
import { userOrgsQueries } from '../db/queries/index.js';
import { logger } from '../lib/logger.js';
import { trackEvent } from '../services/analytics/trackEvent.js';

export const digestPreferencesRouter = Router();

const updateSchema = z.object({
  digestOptIn: z.boolean(),
});

digestPreferencesRouter.get('/digest', async (req, res: Response) => {
  const user = requireUser(req);
  const optIn = await userOrgsQueries.getDigestOptIn(user.org_id, Number(user.sub));
  res.json({ data: { digestOptIn: optIn } });
});

digestPreferencesRouter.patch('/digest', async (req, res: Response) => {
  const user = requireUser(req);
  const result = updateSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'digestOptIn must be a boolean' },
    });
    return;
  }

  await userOrgsQueries.updateDigestOptIn(user.org_id, Number(user.sub), result.data.digestOptIn);

  trackEvent(user.org_id, Number(user.sub), ANALYTICS_EVENTS.DIGEST_PREFERENCE_CHANGED, {
    digestOptIn: result.data.digestOptIn,
  });

  logger.info({ orgId: user.org_id, userId: user.sub, digestOptIn: result.data.digestOptIn }, 'Digest preference updated');
  res.json({ data: { digestOptIn: result.data.digestOptIn } });
});
