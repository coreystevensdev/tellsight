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
import { auditLogsQueries, statCorrectionsQueries, aiSummariesQueries, subscriptionsQueries } from '../db/queries/index.js';
import { dbAdmin } from '../lib/db.js';
import { resolveStatCorrectionSchema } from 'shared/schemas';
import { AUDIT_ACTIONS, ANALYTICS_EVENTS } from 'shared/constants';
import { trackEvent } from '../services/analytics/trackEvent.js';
import { requireUser } from '../lib/requireUser.js';
import { ValidationError, NotFoundError, ConflictError } from '../lib/appError.js';
import { audit } from '../services/audit/auditService.js';
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

// Cross-org admin discovery, same reasoning as /orgs and /audit-logs: an admin
// has no other way to find a pending Tier 2 request without already knowing
// its org and id. Low-volume queue, not a log, so no pagination.
adminRouter.get('/stat-corrections', async (_req: Request, res: Response) => {
  const rows = await statCorrectionsQueries.getPendingCorrections();
  res.json({ data: rows, meta: { total: rows.length } });
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
  if (!row) {
    const existing = await statCorrectionsQueries.findById(correctionId, orgId);
    if (!existing) throw new NotFoundError('Stat correction not found');
    if (existing.status === null) {
      throw new ValidationError('This is a Tier 1 annotation, never queued for review');
    }
    throw new ConflictError(`Stat correction is already ${existing.status}`);
  }

  // Approval changes what the next runFullPipeline call excludes, but
  // ai_summaries is cache-first and only goes stale on upload otherwise.
  // Without this the exclusion wouldn't be visible on the dashboard until
  // the org's next CSV upload, even though the DB-level suppression is
  // already live. markStale invalidates both the dashboard-audience cache
  // (getCachedSummary checks staleAt) and the digest-audience cache
  // (getCachedDigest also checks staleAt), so a correction approved after a
  // digest is already cached for the current week now invalidates that
  // cached digest too -- the next digest read regenerates it, and
  // idx_ai_summaries_digest_unique's widened partial condition
  // (stale_at IS NULL) lets the new row coexist with the stale one.
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

  // orgId here is the correction's target org, not the resolving admin's own
  // org (req.user.org_id), which is why this calls audit() directly instead
  // of auditAuth().
  audit(req, {
    orgId,
    userId: resolverId,
    action: AUDIT_ACTIONS.ADMIN_STAT_CORRECTION_RESOLVED,
    targetType: 'stat_correction',
    targetId: String(correctionId),
    // both checks narrow the same branch (resolution is derived from parsed.data),
    // TS just can't see that link across two separately-typed variables
    metadata:
      resolution.status === 'approved' && parsed.data.status === 'approved'
        ? {
            status: resolution.status,
            expiresInDays: parsed.data.expiresInDays,
            expiresAt: resolution.expiresAt.toISOString(),
          }
        : { status: resolution.status },
  });

  logger.info(
    { orgId, correctionId, resolverId, status: parsed.data.status },
    'Stat correction resolved',
  );
  res.json({ data: row });
});

const agentTierSchema = z.object({ enabled: z.boolean() });

// Manual toggle, per the Epic 18 retro decision: no Stripe-driven Agent-tier
// checkout at beta, so this is the only write path for subscriptions.agent_enabled.
// Platform-admin only via roleGuard('admin') at the router mount (protected.ts),
// same as every other route in this file -- no additional guard needed here.
adminRouter.patch('/orgs/:orgId/agent-tier', async (req: Request, res: Response) => {
  const user = requireUser(req);
  const userId = parseInt(user.sub, 10);
  // Cast required here (unlike GET /orgs/:orgId above): Express 5's route-param
  // type inference doesn't narrow to plain `string` on this deeper path pattern.
  const orgId = parseOrgId(req.params.orgId as string);

  const parsed = agentTierSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: parsed.error.flatten() },
    });
    return;
  }
  const { enabled } = parsed.data;

  // Org existence, not subscription-row existence: updateAgentEnabled upserts,
  // so the only real 404 case left is an orgId with no matching org at all.
  await getOrgDetail(orgId);
  await subscriptionsQueries.updateAgentEnabled(orgId, enabled, dbAdmin);

  audit(req, {
    orgId,
    userId,
    action: enabled ? AUDIT_ACTIONS.ADMIN_AGENT_TIER_ENABLED : AUDIT_ACTIONS.ADMIN_AGENT_TIER_DISABLED,
    targetType: 'subscription',
    targetId: String(orgId),
    metadata: { enabled },
  });
  trackEvent(
    orgId,
    userId,
    enabled ? ANALYTICS_EVENTS.SUBSCRIPTION_AGENT_TIER_ENABLED : ANALYTICS_EVENTS.SUBSCRIPTION_AGENT_TIER_DISABLED,
    { enabled },
  );

  logger.info({ orgId, userId, enabled }, 'Agent tier entitlement toggled');
  res.json({ data: { orgId, agentEnabled: enabled } });
});
