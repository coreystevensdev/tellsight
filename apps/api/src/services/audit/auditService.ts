import type { Request } from 'express';

import { logger } from '../../lib/logger.js';
import { auditLogsQueries } from '../../db/queries/index.js';
import type { AuditEntry } from '../../db/queries/auditLogs.js';

export type { AuditEntry };

/**
 * Fire-and-forget audit log writer. Extracts IP and user-agent
 * from the request, merges with the provided fields, and writes
 * to audit_logs. Never throws, audit failures get logged but
 * don't block the operation being audited.
 */
export function audit(req: Request, entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>): void {
  const ipAddress = req.ip ?? req.socket.remoteAddress ?? null;
  const userAgent = req.headers['user-agent'] ?? null;

  auditLogsQueries
    .record({ ...entry, ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })
    .catch((err) => {
      logger.error({ err, action: entry.action }, 'Failed to write audit log');
    });
}

/**
 * Convenience: extracts userId and orgId from an authenticated request.
 */
export function auditAuth(
  req: Request,
  action: string,
  extra?: { targetType?: string; targetId?: string; metadata?: Record<string, unknown> },
): void {
  const user = req.user;
  audit(req, {
    orgId: user?.org_id ?? null,
    userId: user ? Number(user.sub) : null,
    action,
    ...extra,
  });
}

/**
 * System-event audit for background contexts with no HTTP request (Stripe
 * webhooks, scheduled jobs, BullMQ workers). No IP/UA because the origin
 * isn't a user, the actor is the system itself. Caller provides orgId +
 * optional userId (e.g., the org owner at the time of the event).
 */
export function auditSystem(
  entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>,
): void {
  auditLogsQueries
    .record({ ...entry })
    .catch((err) => {
      logger.error({ err, action: entry.action }, 'Failed to write system audit log');
    });
}
