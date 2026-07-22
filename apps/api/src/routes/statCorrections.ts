import { Router, type Response } from 'express';
import { createStatCorrectionSchema } from 'shared/schemas';

import { requireUser } from '../lib/requireUser.js';
import { withRlsContext } from '../lib/rls.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { statCorrectionsQueries, datasetsQueries } from '../db/queries/index.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';

export const statCorrectionsRouter = Router();

function parseDatasetId(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) throw new ValidationError('Invalid dataset id');
  return parseInt(value, 10);
}

statCorrectionsRouter.get('/:datasetId', async (req, res: Response) => {
  const user = requireUser(req);
  const datasetId = parseDatasetId(req.params.datasetId);

  const corrections = await withRlsContext(user.org_id, user.isAdmin, (tx) =>
    statCorrectionsQueries.getCorrectionsByDataset(user.org_id, datasetId, tx),
  );

  res.json({ data: corrections });
});

statCorrectionsRouter.post('/', roleGuard('owner'), async (req, res: Response) => {
  const user = requireUser(req);
  const userId = parseInt(user.sub, 10);
  const parsed = createStatCorrectionSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid stat correction',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  const { datasetId, statInstanceId, note, appliesGoingForward } = parsed.data;

  const correction = await withRlsContext(user.org_id, user.isAdmin, async (tx) => {
    const dataset = await datasetsQueries.getDatasetById(user.org_id, datasetId, tx);
    if (!dataset) throw new NotFoundError('Dataset not found');

    return statCorrectionsQueries.createCorrection(
      { orgId: user.org_id, datasetId, statInstanceId, userId, note, appliesGoingForward },
      tx,
    );
  });

  req.log.info(
    { orgId: user.org_id, userId, datasetId, statInstanceId, appliesGoingForward, action: 'created' },
    'Stat correction created',
  );

  res.status(201).json({ data: correction });
});
