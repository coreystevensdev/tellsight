import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, agentProposals } from '../schema.js';
import {
  markNotified,
  getExpiredUnfoldedProposals,
  countExpiredUnfoldedProposals,
  type AgentProposalStatus,
} from './agentProposals.js';

// Real Postgres, no mocks -- proves markNotified's status guard actually
// serializes against a concurrent resolveProposal at the database level, not
// just against the mocked query builder unit tests exercise. Lives under
// vitest.integration.config.ts so the default `pnpm test` never picks it up.

let orgId: number;

async function insertTestProposal(overrides: {
  status: AgentProposalStatus;
  resolvedAt?: Date | null;
  title?: string;
}) {
  const [row] = await dbAdmin
    .insert(agentProposals)
    .values({
      orgId,
      kind: 'cash_flow',
      severity: 'warning',
      title: overrides.title ?? 'Burn rate increased 30%',
      explanation: 'Monthly operating expenses rose sharply.',
      recommendation: 'Consider reviewing your largest expense categories.',
      confidence: '0.850',
      evidence: ['monthly_burn_rate'],
      dedupKey: `cash_flow:burn_rate:${Math.random()}`,
      lane: 'auto_notify',
      period: '2026-06',
      status: overrides.status,
      expiresAt: new Date('2026-07-06T00:00:00Z'),
      resolvedAt: overrides.resolvedAt ?? null,
    })
    .returning({ id: agentProposals.id });
  return row!.id;
}

beforeAll(async () => {
  const [org] = await dbAdmin
    .insert(orgs)
    .values({ name: 'Agent Proposal Test Org', slug: `agent-proposal-test-${Date.now()}` })
    .returning({ id: orgs.id });
  orgId = org!.id;
});

afterAll(async () => {
  if (orgId) await dbAdmin.delete(orgs).where(eq(orgs.id, orgId));
});

describe('markNotified against real Postgres', () => {
  it('leaves an approved proposal untouched (concurrent-approval race guard)', async () => {
    const id = await insertTestProposal({ status: 'approved', resolvedAt: new Date() });

    await markNotified(orgId, [id], dbAdmin);

    const [row] = await dbAdmin.select().from(agentProposals).where(eq(agentProposals.id, id));
    expect(row?.status).toBe('approved');
  });

  it('transitions an expired proposal to notified', async () => {
    const id = await insertTestProposal({ status: 'expired', resolvedAt: new Date() });

    await markNotified(orgId, [id], dbAdmin);

    const [row] = await dbAdmin.select().from(agentProposals).where(eq(agentProposals.id, id));
    expect(row?.status).toBe('notified');
  });
});

describe('getExpiredUnfoldedProposals / countExpiredUnfoldedProposals against real Postgres', () => {
  it('caps the returned rows at limit while the count reports the true total', async () => {
    const since = new Date('2026-06-01T00:00:00Z');
    const resolvedAt = new Date('2026-06-15T00:00:00Z');
    for (let i = 0; i < 7; i++) {
      await insertTestProposal({ status: 'expired', resolvedAt, title: `Expired finding ${i}` });
    }

    const limit = 3;
    const rows = await getExpiredUnfoldedProposals(orgId, since, limit, dbAdmin);
    const total = await countExpiredUnfoldedProposals(orgId, since, dbAdmin);

    expect(rows).toHaveLength(limit);
    expect(total).toBe(7);
  });
});
