import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getOrgsWithStats, getUsers, getOrgDetail, getSystemHealth } from '../services/admin/index.js';
import { getAllAnalyticsEvents, getAnalyticsEventsTotal, deleteOlderThan } from '../db/queries/analyticsEvents.js';
import { deleteExpired as deleteExpiredShares } from '../db/queries/shares.js';
import { auditLogsQueries } from '../db/queries/index.js';
import { ValidationError } from '../lib/appError.js';
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
