import { and, eq, lt, gte, inArray, count } from 'drizzle-orm';

import { dbAdmin, type DbTransaction } from '../../lib/db.js';
import { agentProposals } from '../schema.js';

export type AgentProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'notified';

export interface InsertProposalInput {
  orgId: number;
  kind: string;
  severity: string;
  title: string;
  explanation: string;
  recommendation: string;
  confidence: string; // numeric(4,3) comes back as string from Drizzle
  evidence: string[];
  action?: Record<string, unknown> | null;
  dedupKey: string;
  lane: string;
  period: string;
  status: AgentProposalStatus;
  expiresAt: Date;
}

type Client = typeof dbAdmin | DbTransaction;

export async function insertProposal(input: InsertProposalInput, client: Client = dbAdmin) {
  // Validate numeric(4,3) string format: confidence must be parseable and in [0, 1]
  const conf = parseFloat(input.confidence);
  if (isNaN(conf) || conf < 0 || conf > 1) {
    const summary = input.confidence.substring(0, 20);
    throw new Error(`confidence must be numeric string in [0, 1], got "${summary}${input.confidence.length > 20 ? '...' : ''}"`);
  }

  const [row] = await client
    .insert(agentProposals)
    .values({
      ...input,
      action: input.action ?? null,
    })
    .returning({ id: agentProposals.id });
  return row!;
}

export async function getPendingProposals(orgId: number, client: Client = dbAdmin) {
  return client.query.agentProposals.findMany({
    where: and(eq(agentProposals.orgId, orgId), eq(agentProposals.status, 'pending')),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}

export async function getRecentDedupKeys(
  orgId: number,
  since: Date,
  client: Client = dbAdmin,
): Promise<string[]> {
  const rows = await client
    .select({ dedupKey: agentProposals.dedupKey })
    .from(agentProposals)
    .where(and(eq(agentProposals.orgId, orgId), gte(agentProposals.createdAt, since)));
  return rows.map((r) => r.dedupKey);
}

// Approve or reject a single proposal. The caller is responsible for writing
// the PROPOSAL_APPROVED / PROPOSAL_REJECTED audit row via auditSystem().
// orgId is required so a user can only resolve proposals belonging to their org.
export async function resolveProposal(
  proposalId: number,
  status: 'approved' | 'rejected',
  resolvedByUserId: number,
  orgId: number,
  client: Client = dbAdmin,
) {
  const [row] = await client
    .update(agentProposals)
    .set({ status, resolvedAt: new Date(), resolvedByUserId })
    .where(and(
      eq(agentProposals.id, proposalId),
      eq(agentProposals.orgId, orgId),
      eq(agentProposals.status, 'pending'),
    ))
    .returning({ id: agentProposals.id, orgId: agentProposals.orgId });
  return row ?? null;
}

// Mark auto_notify and expired-fold-in proposals as notified once the digest
// that included them is sent. orgId keeps a worker scoped to its own org; the
// status guard makes this a compare-and-swap so a proposal a user resolves
// concurrently (Action Drawer approve/reject) between the fold-in fetch and
// this commit is never clobbered back to 'notified'.
export async function markNotified(orgId: number, ids: number[], client: Client = dbAdmin) {
  if (ids.length === 0) return;
  await client
    .update(agentProposals)
    .set({ status: 'notified', resolvedAt: new Date() })
    .where(and(
      eq(agentProposals.orgId, orgId),
      inArray(agentProposals.id, ids),
      inArray(agentProposals.status, ['pending', 'expired']),
    ));
}

// Expiry sweep: called by the digest orchestrator tick. Returns the ids that
// were expired so the caller can fold them into the next digest summary.
export async function expireProposals(before: Date, client: Client = dbAdmin): Promise<number[]> {
  const rows = await client
    .update(agentProposals)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(and(eq(agentProposals.status, 'pending'), lt(agentProposals.expiresAt, before)))
    .returning({ id: agentProposals.id });
  return rows.map((r) => r.id);
}

// How far back a digest reaches for expired proposals it has not folded in.
//
// The resolvedAt window is a staleness bound, not a watermark: `status` already
// tracks fold-in state, going expired -> notified once a digest carrying the
// proposal sends. Scoping to weekStart alone made it act like a watermark by
// accident, because every run re-anchored it, so anything expired during a week
// whose digest never sent fell out of range for good. That contradicts the
// guarantee perOrg states for a rolled-back markNotified: those proposals
// "fold into next week's digest too, a duplicate notification rather than a
// lost one". Four weeks covers three consecutive missed runs and still keeps a
// two-month-old finding out of an inbox.
const FOLD_IN_LOOKBACK_MS = 28 * 24 * 60 * 60 * 1000;

function foldInSince(weekStart: Date): Date {
  return new Date(weekStart.getTime() - FOLD_IN_LOOKBACK_MS);
}

// Expired proposals not yet folded into a digest, from weekStart back through
// the lookback above. limit bounds a multi-week outage from feeding an
// unbounded bullet list into one digest; the caller pairs this with
// countExpiredUnfoldedProposals to report what got omitted.
export async function getExpiredUnfoldedProposals(
  orgId: number,
  weekStart: Date,
  limit: number,
  client: Client = dbAdmin,
) {
  return client.query.agentProposals.findMany({
    where: and(
      eq(agentProposals.orgId, orgId),
      eq(agentProposals.status, 'expired'),
      gte(agentProposals.resolvedAt, foldInSince(weekStart)),
    ),
    // id tiebreaks expiresAt so a retried job sees the same LIMIT-ed subset,
    // not a different one every time two proposals expire at the same tick.
    orderBy: (t, { desc }) => [desc(t.expiresAt), desc(t.id)],
    limit,
  });
}

// Exact count behind getExpiredUnfoldedProposals' same predicate, unbounded
// by limit, so the digest can report precisely how many findings the cap left out.
export async function countExpiredUnfoldedProposals(
  orgId: number,
  weekStart: Date,
  client: Client = dbAdmin,
): Promise<number> {
  const [row] = await client
    .select({ value: count() })
    .from(agentProposals)
    .where(and(
      eq(agentProposals.orgId, orgId),
      eq(agentProposals.status, 'expired'),
      gte(agentProposals.resolvedAt, foldInSince(weekStart)),
    ));
  return row?.value ?? 0;
}
