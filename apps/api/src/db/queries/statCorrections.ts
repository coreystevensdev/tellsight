import { and, desc, eq, inArray, lt } from 'drizzle-orm';

import { db, dbAdmin, type DbTransaction } from '../../lib/db.js';
import { ConflictError } from '../../lib/appError.js';
import { statCorrections, orgs, datasets } from '../schema.js';

export type StatCorrectionRow = typeof statCorrections.$inferSelect;

type Client = typeof db | typeof dbAdmin | DbTransaction;

export interface CreateCorrectionInput {
  orgId: number;
  datasetId: number;
  statInstanceId: string;
  userId: number;
  note: string;
  appliesGoingForward: boolean;
}

// postgres.js maps the Postgres unique_violation SQLSTATE onto err.code, and
// idx_stat_corrections_org_stat_active is the only unique constraint this
// table has, so a 23505 here always means an active Tier 2 request already
// exists for this org + stat instance.
function isDuplicateActiveCorrection(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

export async function createCorrection(
  input: CreateCorrectionInput,
  client: typeof db | DbTransaction = db,
): Promise<StatCorrectionRow> {
  try {
    const [row] = await client
      .insert(statCorrections)
      .values({
        orgId: input.orgId,
        datasetId: input.datasetId,
        statInstanceId: input.statInstanceId,
        userId: input.userId,
        note: input.note,
        appliesGoingForward: input.appliesGoingForward,
        status: input.appliesGoingForward ? 'pending' : null,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isDuplicateActiveCorrection(err)) {
      throw new ConflictError('A pending or approved correction already exists for this stat');
    }
    throw err;
  }
}

export async function getCorrectionsByDataset(
  orgId: number,
  datasetId: number,
  client: typeof db | DbTransaction = db,
): Promise<StatCorrectionRow[]> {
  return client
    .select()
    .from(statCorrections)
    .where(and(eq(statCorrections.orgId, orgId), eq(statCorrections.datasetId, datasetId)))
    .orderBy(desc(statCorrections.createdAt));
}

// Cross-org admin discovery route, same reasoning as auditLogs.query and
// getOrgsWithStats: there's no per-org list of pending Tier 2 requests
// anywhere in the product, so the admin has no way to find one without this.
export async function getPendingCorrections(client: Client = dbAdmin) {
  return client
    .select({
      id: statCorrections.id,
      orgId: statCorrections.orgId,
      orgName: orgs.name,
      datasetId: statCorrections.datasetId,
      datasetName: datasets.name,
      statInstanceId: statCorrections.statInstanceId,
      note: statCorrections.note,
      appliesGoingForward: statCorrections.appliesGoingForward,
      createdAt: statCorrections.createdAt,
    })
    .from(statCorrections)
    .innerJoin(orgs, eq(orgs.id, statCorrections.orgId))
    .innerJoin(datasets, eq(datasets.id, statCorrections.datasetId))
    .where(eq(statCorrections.status, 'pending'))
    .orderBy(desc(statCorrections.createdAt));
}

// Unscoped by status, unlike resolveCorrection's guarded UPDATE, so a failed
// resolve can tell a missing row apart from one that's already settled.
export async function findById(
  correctionId: number,
  orgId: number,
  client: Client = dbAdmin,
): Promise<StatCorrectionRow | null> {
  const [row] = await client
    .select()
    .from(statCorrections)
    .where(and(eq(statCorrections.id, correctionId), eq(statCorrections.orgId, orgId)));
  return row ?? null;
}

// Approve/reject a pending Tier 2 request. Atomic WHERE status = 'pending',
// same race guard as agentProposals' resolveProposal: exactly one of two
// concurrent approve/reject calls on the same row wins, the other gets null.
export async function resolveCorrection(
  correctionId: number,
  orgId: number,
  resolvedByUserId: number,
  resolution: { status: 'approved'; expiresAt: Date } | { status: 'rejected' },
  client: Client = dbAdmin,
): Promise<StatCorrectionRow | null> {
  const [row] = await client
    .update(statCorrections)
    .set({
      status: resolution.status,
      resolvedAt: new Date(),
      resolvedByUserId,
      ...(resolution.status === 'approved' && { expiresAt: resolution.expiresAt }),
    })
    .where(and(
      eq(statCorrections.id, correctionId),
      eq(statCorrections.orgId, orgId),
      eq(statCorrections.status, 'pending'),
    ))
    .returning();
  return row ?? null;
}

// The only allowed effect of an approved Tier 2 correction: its statInstanceId
// gets excluded from scoreInsights()'s selection for this org. Doesn't check
// expiresAt itself, that's the expiry sweep's job (expireCorrections below);
// once a row flips to 'expired' it drops out of this query on its own.
export async function getActiveCorrectionStatIds(
  orgId: number,
  client: Client = dbAdmin,
): Promise<string[]> {
  const rows = await client
    .select({ statInstanceId: statCorrections.statInstanceId })
    .from(statCorrections)
    .where(and(eq(statCorrections.orgId, orgId), eq(statCorrections.status, 'approved')));
  return rows.map((r) => r.statInstanceId);
}

export interface ExpiredCorrection {
  id: number;
  orgId: number;
  datasetId: number;
}

// Expiry sweep, mirrors expireProposals' shape: returns orgId/datasetId per
// flipped row (not just id) so the caller can invalidate the right
// ai_summaries cache entries without a second query.
export async function expireCorrections(before: Date, client: Client = dbAdmin): Promise<ExpiredCorrection[]> {
  return client
    .update(statCorrections)
    .set({ status: 'expired' })
    .where(and(eq(statCorrections.status, 'approved'), lt(statCorrections.expiresAt, before)))
    .returning({
      id: statCorrections.id,
      orgId: statCorrections.orgId,
      datasetId: statCorrections.datasetId,
    });
}

export interface ApprovedCorrection {
  id: number;
  orgId: number;
  datasetId: number;
  statInstanceId: string;
}

// Feeds the expiry sweep's Anomaly re-validation pass (DW-64). Returns every
// approved row regardless of stat type; the handler is the one that filters
// down to Anomaly ids, so this stays a plain unfiltered read.
export async function getApprovedCorrections(client: Client = dbAdmin): Promise<ApprovedCorrection[]> {
  return client
    .select({
      id: statCorrections.id,
      orgId: statCorrections.orgId,
      datasetId: statCorrections.datasetId,
      statInstanceId: statCorrections.statInstanceId,
    })
    .from(statCorrections)
    .where(eq(statCorrections.status, 'approved'));
}

// Bulk flip for rows the expiry sweep found no longer match a fresh recompute
// (DW-64). WHERE status = 'approved' mirrors expireCorrections' guard, so a
// row that resolved or expired between the sweep's SELECT and this UPDATE
// can't be double-flipped. Returns only the ids that actually flipped.
export async function orphanCorrections(ids: number[], client: Client = dbAdmin): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await client
    .update(statCorrections)
    .set({ status: 'orphaned' })
    .where(and(inArray(statCorrections.id, ids), eq(statCorrections.status, 'approved')))
    .returning({ id: statCorrections.id });
  return rows.map((r) => r.id);
}
