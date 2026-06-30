import { and, eq, lt, gte, inArray } from 'drizzle-orm';

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
  const [row] = await client
    .insert(agentProposals)
    .values({
      ...input,
      evidence: input.evidence,
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
export async function resolveProposal(
  proposalId: number,
  status: 'approved' | 'rejected',
  resolvedByUserId: number,
  client: Client = dbAdmin,
) {
  const [row] = await client
    .update(agentProposals)
    .set({ status, resolvedAt: new Date(), resolvedByUserId })
    .where(and(eq(agentProposals.id, proposalId), eq(agentProposals.status, 'pending')))
    .returning({ id: agentProposals.id, orgId: agentProposals.orgId });
  return row ?? null;
}

// Mark auto_notify proposals as notified after the digest includes them.
export async function markNotified(ids: number[], client: Client = dbAdmin) {
  if (ids.length === 0) return;
  await client
    .update(agentProposals)
    .set({ status: 'notified', resolvedAt: new Date() })
    .where(inArray(agentProposals.id, ids));
}

// Expiry sweep: called by the nightly worker. Returns the ids that were
// expired so the caller can fold them into the next digest summary.
export async function expireProposals(before: Date, client: Client = dbAdmin): Promise<number[]> {
  const rows = await client
    .update(agentProposals)
    .set({ status: 'expired', resolvedAt: new Date() })
    .where(and(eq(agentProposals.status, 'pending'), lt(agentProposals.expiresAt, before)))
    .returning({ id: agentProposals.id });
  return rows.map((r) => r.id);
}
