import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { roleGuard } from '../middleware/roleGuard.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { datasetsQueries, orgsQueries } from '../db/queries/index.js';
import { withRlsContext } from '../lib/rls.js';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { ANALYTICS_EVENTS, AUDIT_ACTIONS } from 'shared/constants';
import { logger } from '../lib/logger.js';
import { auditAuth } from '../services/audit/auditService.js';

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

  const datasets = await withRlsContext(orgId, isAdmin, async (tx) => {
    const activeDatasetId = await orgsQueries.getActiveDatasetId(orgId, tx);
    return datasetsQueries.getDatasetListWithCounts(orgId, activeDatasetId, tx);
  });

  res.json({ data: datasets });
});

// GET /datasets/manage/:id — single dataset with row/summary/share counts
datasetManagementRouter.get('/manage/:id', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, isAdmin } = user;
  const datasetId = parseDatasetId(req.params.id);

  const result = await withRlsContext(orgId, isAdmin, async (tx) => {
    const [activeId, ds] = await Promise.all([
      orgsQueries.getActiveDatasetId(orgId, tx),
      datasetsQueries.getDatasetWithCounts(orgId, datasetId, tx),
    ]);
    if (!ds) throw new NotFoundError('Dataset not found');
    return { ...ds, isActive: ds.id === activeId };
  });

  res.json({ data: result });
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

  const { existing, updated } = await withRlsContext(orgId, isAdmin, async (tx) => {
    const found = await datasetsQueries.getDatasetById(orgId, datasetId, tx);
    if (!found) throw new NotFoundError('Dataset not found');
    const renamed = await datasetsQueries.updateDatasetName(orgId, datasetId, name, tx);
    return { existing: found, updated: renamed };
  });

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

  const { existing, newActiveDatasetId } = await withRlsContext(orgId, isAdmin, async (tx) => {
    const found = await datasetsQueries.getDatasetWithCounts(orgId, datasetId, tx);
    if (!found) throw new NotFoundError('Dataset not found');

    await datasetsQueries.deleteDataset(orgId, datasetId, tx);

    // ON DELETE SET NULL already cleared active_dataset_id if this was active.
    // Promote the next newest non-seed dataset if active is now null.
    const currentActive = await orgsQueries.getActiveDatasetId(orgId, tx);
    let nextActiveId: number | null = currentActive;

    if (currentActive === null) {
      const remaining = await datasetsQueries.getDatasetsByOrg(orgId, tx);
      const next = remaining.find((ds) => !ds.isSeedData) ?? null;
      if (next) {
        await orgsQueries.setActiveDataset(orgId, next.id, tx);
        nextActiveId = next.id;
      }
    }

    return { existing: found, newActiveDatasetId: nextActiveId };
  });

  logger.info({ orgId, datasetId, newActiveDatasetId }, 'dataset deleted');

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_DELETED, {
    datasetId,
    rowCount: existing.rowCount,
    hadActiveShares: existing.shareCount > 0,
    newActiveDatasetId,
  });

  auditAuth(req, AUDIT_ACTIONS.DATASET_DELETED, {
    targetType: 'dataset',
    targetId: String(datasetId),
    metadata: { name: existing.name, rowCount: existing.rowCount },
  });

  res.json({ data: { deleted: true, newActiveDatasetId } });
});

// POST /datasets/manage/:id/activate — set as org's active dataset
datasetManagementRouter.post('/manage/:id/activate', async (req, res: Response) => {
  const user = authedUser(req);
  const { org_id: orgId, sub, isAdmin } = user;
  const userId = parseInt(sub, 10);
  const datasetId = parseDatasetId(req.params.id);

  const previousDatasetId = await withRlsContext(orgId, isAdmin, async (tx) => {
    const dataset = await datasetsQueries.getDatasetById(orgId, datasetId, tx);
    if (!dataset) throw new NotFoundError('Dataset not found');

    const prevId = await orgsQueries.getActiveDatasetId(orgId, tx);
    await orgsQueries.setActiveDataset(orgId, datasetId, tx);
    return prevId;
  });

  logger.info({ orgId, datasetId, previousDatasetId }, 'dataset activated');

  trackEvent(orgId, userId, ANALYTICS_EVENTS.DATASET_ACTIVATED, { datasetId, previousDatasetId });

  res.json({ data: { activeDatasetId: datasetId } });
});
