import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { datasetsQueries, orgsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../lib/logger.js';

export const datasetManagementRouter = Router();

function parseDatasetId(raw: string | undefined): number {
  const id = parseInt(raw ?? '', 10);
  if (isNaN(id)) throw new ValidationError('Invalid dataset id');
  return id;
}

function authedUser(req: Request) {
  return (req as unknown as AuthenticatedRequest).user;
}

// GET /datasets/manage — list non-seed datasets for the org
datasetManagementRouter.get('/manage', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, isAdmin } = user;

  const activeDatasetId = await withRlsContext(orgId, isAdmin, (tx) =>
    orgsQueries.getActiveDatasetId(orgId, tx),
  );

  const datasets = await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.getDatasetListWithCounts(orgId, activeDatasetId, tx),
  );

  res.json({ data: datasets });
});

// GET /datasets/manage/:id — single dataset with row/summary/share counts
datasetManagementRouter.get('/manage/:id', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, isAdmin } = user;
  const datasetId = parseDatasetId(req.params.id);

  const [activeDatasetId, dataset] = await Promise.all([
    withRlsContext(orgId, isAdmin, (tx) => orgsQueries.getActiveDatasetId(orgId, tx)),
    withRlsContext(orgId, isAdmin, (tx) => datasetsQueries.getDatasetWithCounts(orgId, datasetId, tx)),
  ]);

  if (!dataset) throw new NotFoundError('Dataset not found');

  res.json({ data: { ...dataset, isActive: dataset.id === activeDatasetId } });
});

// PATCH /datasets/manage/:id — rename
datasetManagementRouter.patch('/manage/:id', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, sub, isAdmin } = user;
  const userId = parseInt(sub, 10);
  const datasetId = parseDatasetId(req.params.id);

  const rawName: unknown = req.body?.name;
  if (typeof rawName !== 'string') throw new ValidationError('name is required');

  const name = rawName.trim();
  if (name.length < 1 || name.length > 255) {
    throw new ValidationError('name must be between 1 and 255 characters');
  }

  const existing = await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.getDatasetById(orgId, datasetId, tx),
  );
  if (!existing) throw new NotFoundError('Dataset not found');

  const updated = await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.updateDatasetName(orgId, datasetId, name, tx),
  );

  logger.info({ orgId, datasetId, oldName: existing.name, newName: name }, 'dataset renamed');

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_RENAMED, {
    datasetId,
    oldName: existing.name,
    newName: name,
  });

  res.json({ data: updated });
});

// DELETE /datasets/manage/:id — owner only, cascades, auto-switches active dataset
datasetManagementRouter.delete('/manage/:id', roleGuard('owner'), async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, sub, isAdmin } = user;
  const userId = parseInt(sub, 10);
  const datasetId = parseDatasetId(typeof req.params.id === 'string' ? req.params.id : undefined);

  const existing = await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.getDatasetById(orgId, datasetId, tx),
  );
  if (!existing) throw new NotFoundError('Dataset not found');

  await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.deleteDataset(orgId, datasetId, tx),
  );

  // ON DELETE SET NULL already cleared active_dataset_id if this was active.
  // If it's now null, promote the next newest non-seed dataset automatically.
  let newActiveDatasetId: number | null = null;

  const currentActive = await withRlsContext(orgId, isAdmin, (tx) =>
    orgsQueries.getActiveDatasetId(orgId, tx),
  );

  if (currentActive === null) {
    const remaining = await datasetsQueries.getDatasetsByOrg(orgId);
    const next = remaining.find((ds) => !ds.isSeedData) ?? null;

    if (next) {
      await withRlsContext(orgId, isAdmin, (tx) =>
        orgsQueries.setActiveDataset(orgId, next.id, tx),
      );
      newActiveDatasetId = next.id;
    }
  } else {
    newActiveDatasetId = currentActive;
  }

  logger.info({ orgId, datasetId, newActiveDatasetId }, 'dataset deleted');

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_DELETED, {
    datasetId,
    newActiveDatasetId,
  });

  res.json({ data: { deleted: true, newActiveDatasetId } });
});

// POST /datasets/manage/:id/activate — set as org's active dataset
datasetManagementRouter.post('/manage/:id/activate', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, sub, isAdmin } = user;
  const userId = parseInt(sub, 10);
  const datasetId = parseDatasetId(req.params.id);

  const dataset = await withRlsContext(orgId, isAdmin, (tx) =>
    datasetsQueries.getDatasetById(orgId, datasetId, tx),
  );
  if (!dataset) throw new NotFoundError('Dataset not found');

  await withRlsContext(orgId, isAdmin, (tx) =>
    orgsQueries.setActiveDataset(orgId, datasetId, tx),
  );

  logger.info({ orgId, datasetId }, 'dataset activated');

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_ACTIVATED, { datasetId });

  res.json({ data: { activeDatasetId: datasetId } });
});
