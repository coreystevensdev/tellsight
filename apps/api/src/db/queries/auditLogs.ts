import { eq, and, gte, lte, desc, count, type SQL } from 'drizzle-orm';
import { dbAdmin } from '../../lib/db.js';
import { auditLogs, orgs, users } from '../schema.js';

export interface AuditEntry {
  orgId: number | null;
  userId: number | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function record(entry: AuditEntry) {
  const [row] = await dbAdmin
    .insert(auditLogs)
    .values({
      orgId: entry.orgId,
      userId: entry.userId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    })
    .returning();
  return row!;
}

export interface AuditFilter {
  orgId?: number;
  userId?: number;
  action?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

function buildConditions(opts: AuditFilter): SQL | undefined {
  const conditions: SQL[] = [];

  if (opts.orgId) conditions.push(eq(auditLogs.orgId, opts.orgId));
  if (opts.userId) conditions.push(eq(auditLogs.userId, opts.userId));
  if (opts.action) conditions.push(eq(auditLogs.action, opts.action));
  if (opts.startDate) conditions.push(gte(auditLogs.createdAt, opts.startDate));
  if (opts.endDate) conditions.push(lte(auditLogs.createdAt, opts.endDate));

  return conditions.length ? and(...conditions) : undefined;
}

export async function query(opts: AuditFilter) {
  const { limit = 50, offset = 0 } = opts;
  const where = buildConditions(opts);

  return dbAdmin
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      orgName: orgs.name,
      userEmail: users.email,
      userName: users.name,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(orgs, eq(orgs.id, auditLogs.orgId))
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function total(opts: AuditFilter) {
  const where = buildConditions(opts);
  const [row] = await dbAdmin
    .select({ value: count() })
    .from(auditLogs)
    .where(where);
  return row?.value ?? 0;
}
