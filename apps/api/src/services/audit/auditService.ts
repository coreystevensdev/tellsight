import type { Request } from 'express';

import { logger } from '../../lib/logger.js';
import { auditLogsQueries } from '../../db/queries/index.js';
import type { AuditEntry } from '../../db/queries/auditLogs.js';

export type { AuditEntry };

export function audit(req: Request, entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>): void {
  const ipAddress = req.ip ?? req.socket.remoteAddress ?? null;
  const userAgent = req.headers['user-agent'] ?? null;

  auditLogsQueries
    .record({ ...entry, ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })
    .catch((err) => {
      logger.error({ err, action: entry.action }, 'Failed to write audit log');
    });
}

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

// No IP/UA: background contexts (webhooks, workers) have no HTTP request.
export function auditSystem(
  entry: Omit<AuditEntry, 'ipAddress' | 'userAgent'>,
): void {
  auditLogsQueries
    .record({ ...entry })
    .catch((err) => {
      logger.error({ err, action: entry.action }, 'Failed to write system audit log');
    });
}
