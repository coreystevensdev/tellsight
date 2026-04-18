import { Router } from 'express';
import type { Response } from 'express';
import { businessProfileSchema } from 'shared/schemas';
import { requireUser } from '../lib/requireUser.js';
import { orgsQueries } from '../db/queries/index.js';
import { logger } from '../lib/logger.js';

export const orgProfileRouter = Router();

orgProfileRouter.get('/profile', async (req, res: Response) => {
  const orgId = requireUser(req).org_id;
  const profile = await orgsQueries.getBusinessProfile(orgId);
  res.json({ data: profile });
});

orgProfileRouter.put('/profile', async (req, res: Response) => {
  const orgId = requireUser(req).org_id;
  const result = businessProfileSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid business profile', details: result.error.issues },
    });
    return;
  }

  await orgsQueries.updateBusinessProfile(orgId, result.data);
  logger.info({ orgId }, 'Business profile updated');
  res.json({ data: result.data });
});
