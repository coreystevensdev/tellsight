import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getOrgsWithStats,
  getUsers,
  getOrgDetail,
  getSystemHealth,
  getEmailComplianceMetrics,
  getAlertComplianceMetrics,
} from '../services/admin/index.js';
import { getAllAnalyticsEvents, getAnalyticsEventsTotal, deleteOlderThan } from '../db/queries/analyticsEvents.js';
import { deleteExpired as deleteExpiredShares } from '../db/queries/shares.js';
import { auditLogsQueries, statCorrectionsQueries, aiSummariesQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { resolveStatCorrectionSchema } from 'shared/schemas';
import { requireUser } from '../lib/requireUser.js';
import { ValidationError, NotFoundError } from '../lib/appError.js';
import { env } from '../config.js';
import { logger } from '../lib/logger.js';

const orgIdParam = z.coerce.number().int().positive();

function parseOrgId(raw: string): number {
  const result = orgIdParam.safeParse(raw);
  if (!result.success) throw new ValidationError('Invalid org ID');
  return result.data;
}

const analyticsEventsQuerySchema = z.object({
  eventName: z.string().optional(),
  orgId: z.coerce.number().int().positive().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminRouter = Router();

adminRouter.get('/orgs', async (_req, res: Response) => {
  const { orgs, stats } = await getOrgsWithStats();
  res.json({ data: orgs, meta: { total: orgs.length, stats } });
});

adminRouter.get('/users', async (_req, res: Response) => {
  const users = await getUsers();
  res.json({ data: users, meta: { total: users.length } });
});

adminRouter.get('/orgs/:orgId', async (req, res: Response) => {
  const orgId = parseOrgId(req.params.orgId);
  const org = await getOrgDetail(orgId);
  res.json({ data: org });
});

adminRouter.get('/health', async (_req, res: Response) => {
  const health = await getSystemHealth();
  res.json({ data: health });
});

adminRouter.get('/email-compliance', async (_req, res: Response) => {
  const metrics = await getEmailComplianceMetrics();
  res.json({ data: metrics });
});

adminRouter.get('/alert-compliance', async (req: Request, res: Response) => {
  const metrics = await getAlertComplianceMetrics();
  req.log.info({ action: 'alert_compliance_viewed' }, 'Admin alert compliance panel viewed');
  res.json({ data: metrics });
});

adminRouter.get('/analytics-events', async (req: Request, res: Response) => {
  const parsed = analyticsEventsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid query parameters', parsed.error.issues);

  const { limit, offset, ...filters } = parsed.data;
  const [events, total] = await Promise.all([
    getAllAnalyticsEvents({ ...filters, limit, offset }),
    getAnalyticsEventsTotal(filters),
  ]);

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit) || 1;

  res.json({
    data: events,
    meta: { total, pagination: { page, pageSize: limit, totalPages } },
  });
});

adminRouter.post('/analytics-events/cleanup', async (_req, res: Response) => {
  const retentionDays = env.ANALYTICS_RETENTION_DAYS;
  const deleted = await deleteOlderThan(retentionDays);
  logger.info({ retentionDays, deleted }, 'analytics events cleanup completed');
  res.json({ data: { deleted, retentionDays } });
});

adminRouter.post('/shares/cleanup', async (_req, res: Response) => {
  const deleted = await deleteExpiredShares();
  logger.info({ deleted }, 'expired shares cleanup completed');
  res.json({ data: { deleted } });
});

const auditQuerySchema = z.object({
  action: z.string().optional(),
  orgId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

adminRouter.get('/audit-logs', async (req: Request, res: Response) => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ValidationError('Invalid query parameters', parsed.error.issues);

  const { limit, offset, ...filters } = parsed.data;
  const [logs, count] = await Promise.all([
    auditLogsQueries.query({ ...filters, limit, offset }),
    auditLogsQueries.total(filters),
  ]);

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(count / limit) || 1;

  res.json({
    data: logs,
    meta: { total: count, pagination: { page, pageSize: limit, totalPages } },
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function parseCorrectionParams(raw: { orgId: string; id: string }): { orgId: number; correctionId: number } {
  const orgId = Number(raw.orgId);
  const correctionId = Number(raw.id);
  if (!Number.isInteger(orgId) || orgId <= 0) throw new ValidationError('Invalid org id');
  if (!Number.isInteger(correctionId) || correctionId <= 0) throw new ValidationError('Invalid correction id');
  return { orgId, correctionId };
}

// Tier 2 review gate (intent-contract): approval is platform-admin only, never
// self-approved by the correcting org, hence orgId in the path rather than
// taken from req.user like the org-scoped /proposals PATCH route.
adminRouter.patch('/stat-corrections/:orgId/:id', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const resolverId = parseInt(user.sub, 10);
  const { orgId, correctionId } = parseCorrectionParams(req.params as { orgId: string; id: string });

  const parsed = resolveStatCorrectionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid resolution', details: parsed.error.flatten() },
    });
    return;
  }

  const resolution =
    parsed.data.status === 'approved'
      ? { status: 'approved' as const, expiresAt: new Date(Date.now() + parsed.data.expiresInDays * DAY_MS) }
      : { status: 'rejected' as const };

  const row = await statCorrectionsQueries.resolveCorrection(correctionId, orgId, resolverId, resolution);
  if (!row) throw new NotFoundError('Stat correction not found or already resolved');

  // Approval changes what the next runFullPipeline call excludes, but
  // ai_summaries is cache-first and only goes stale on upload otherwise.
  // Without this the exclusion wouldn't be visible on the dashboard until
  // the org's next CSV upload, even though the DB-level suppression is
  // already live. This only affects the dashboard-audience cache
  // (getCachedSummary checks staleAt); the digest-audience cache
  // (getCachedDigest) is pinned to weekStart by design and never consults
  // staleAt, so a correction approved after a digest is already cached for
  // the current week won't retroactively change that cached digest -- it
  // takes effect on the next digest generation cycle instead, the same way
  // any other data change already behaves for digest.
  // resolveCorrection's WHERE status='pending' guard means a retry after a
  // markStale failure here would 404 (the row is already 'approved'), so
  // this can't be recovered by simply retrying the request -- swallow and
  // log instead of 500ing on an approval that already succeeded in the DB.
  if (parsed.data.status === 'approved') {
    try {
      await aiSummariesQueries.markStale(orgId, dbAdmin, row.datasetId);
    } catch (err) {
      logger.error(
        { err, orgId, correctionId, datasetId: row.datasetId },
        'Stat correction approved but failed to invalidate ai_summaries cache; cached summary keeps showing the un-suppressed stat until next CSV upload',
      );
    }
  }

  logger.info(
    { orgId, correctionId, resolverId, status: parsed.data.status },
    'Stat correction resolved',
  );
  res.json({ data: row });
});
