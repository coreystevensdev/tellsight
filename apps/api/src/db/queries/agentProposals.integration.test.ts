import { eq } from 'drizzle-orm';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { dbAdmin } from '../../lib/db.js';
import { orgs, users, agentProposals } from '../schema.js';
import {
  markNotified,
  getExpiredUnfoldedProposals,
  countExpiredUnfoldedProposals,
  resolveProposal,
  type AgentProposalStatus,
} from './agentProposals.js';

// Real Postgres, no mocks -- proves markNotified's status guard actually
// serializes against a concurrent resolveProposal at the database level, not
// just against the mocked query builder unit tests exercise. Lives under
// vitest.integration.config.ts so the default `pnpm test` never picks it up.

let orgId: number;
let otherOrgId: number;
// A real row: resolved_by_user_id carries a foreign key, so a made-up id fails
// against a migrated database even though the mocked unit tests never notice.
let resolverUserId: number;

async function insertTestProposal(overrides: {
  status: AgentProposalStatus;
  resolvedAt?: Date | null;
  title?: string;
  orgId?: number;
}) {
  const [row] = await dbAdmin
    .insert(agentProposals)
    .values({
      orgId: overrides.orgId ?? orgId,
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

  const [other] = await dbAdmin
    .insert(orgs)
    .values({ name: 'Agent Proposal Other Org', slug: `agent-proposal-other-${Date.now()}` })
    .returning({ id: orgs.id });
  otherOrgId = other!.id;

  const [user] = await dbAdmin
    .insert(users)
    .values({ email: `agent-proposal-resolver-${Date.now()}@test.local`, name: 'Resolver' })
    .returning({ id: users.id });
  resolverUserId = user!.id;
});

afterAll(async () => {
  if (orgId) await dbAdmin.delete(orgs).where(eq(orgs.id, orgId));
  if (otherOrgId) await dbAdmin.delete(orgs).where(eq(orgs.id, otherOrgId));
  if (resolverUserId) await dbAdmin.delete(users).where(eq(users.id, resolverUserId));
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

// agentProposals.test.ts mocks the query builder and asserts only what .set()
// received, so none of resolveProposal's three predicates were checked. Dropping
// eq(orgId) left the whole API suite green. RLS backstops this for a normal
// member, but the route passes user.isAdmin into withRlsContext, so for a
// platform admin the query predicate is the only org scoping left.
describe('resolveProposal against real Postgres', () => {
  it('approves a pending proposal in the caller org', async () => {
    const id = await insertTestProposal({ status: 'pending' });

    const row = await resolveProposal(id, 'approved', resolverUserId, orgId);

    expect(row).toMatchObject({ id, orgId });
    const [after] = await dbAdmin
      .select({ status: agentProposals.status, by: agentProposals.resolvedByUserId })
      .from(agentProposals)
      .where(eq(agentProposals.id, id));
    expect(after).toMatchObject({ status: 'approved', by: resolverUserId });
  });

  it('refuses a proposal belonging to another org and leaves it pending', async () => {
    const id = await insertTestProposal({ status: 'pending', orgId: otherOrgId });

    const row = await resolveProposal(id, 'approved', resolverUserId, orgId);

    expect(row).toBeNull();
    const [after] = await dbAdmin
      .select({ status: agentProposals.status })
      .from(agentProposals)
      .where(eq(agentProposals.id, id));
    expect(after?.status).toBe('pending');
  });

  // Two approvals racing must not both win, which is the same guard markNotified
  // relies on from the other side.
  it('refuses a proposal that is no longer pending', async () => {
    const id = await insertTestProposal({ status: 'approved', resolvedAt: new Date() });

    expect(await resolveProposal(id, 'rejected', resolverUserId, orgId)).toBeNull();
  });
});
