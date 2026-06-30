import { describe, it, expect, vi } from 'vitest';

// Prevent dbAdmin from opening a real connection at import time
vi.mock('../../lib/db.js', () => ({ dbAdmin: {} }));

const {
  insertProposal,
  getPendingProposals,
  getRecentDedupKeys,
  resolveProposal,
  markNotified,
  expireProposals,
} = await import('./agentProposals.js');

// ── mock client builders ──────────────────────────────────────────────────────

function insertClient(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { client: { insert } as never, mocks: { insert, values, returning } };
}

function findManyClient(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { client: { query: { agentProposals: { findMany } } } as never, mocks: { findMany } };
}

function selectClient(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { client: { select } as never, mocks: { select, from, where } };
}

// update that ends with .returning()
function updateReturningClient(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { client: { update } as never, mocks: { update, set, where, returning } };
}

// update that ends at .where() (no returning)
function updateNoReturnClient() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { client: { update } as never, mocks: { update, set, where } };
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const baseInput = {
  orgId: 1,
  kind: 'cash_flow',
  severity: 'warning',
  title: 'Burn rate increased 30%',
  explanation: 'Monthly operating expenses rose sharply.',
  recommendation: 'Consider reviewing your largest expense categories.',
  confidence: '0.850',
  evidence: ['monthly_burn_rate', 'payroll_total'],
  action: null,
  dedupKey: 'cash_flow:burn_rate:default',
  lane: 'auto_notify',
  period: '2026-06',
  status: 'pending' as const,
  expiresAt: new Date('2026-07-06T00:00:00Z'),
};

// ── insertProposal ────────────────────────────────────────────────────────────

describe('insertProposal', () => {
  it('inserts the input fields and returns the generated id', async () => {
    const { client, mocks } = insertClient([{ id: 42 }]);

    const result = await insertProposal(baseInput, client);

    expect(result).toEqual({ id: 42 });
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 1,
        kind: 'cash_flow',
        confidence: '0.850',
        evidence: ['monthly_burn_rate', 'payroll_total'],
        action: null,
      }),
    );
    expect(mocks.returning).toHaveBeenCalledOnce();
  });

  it('sets action to null when not supplied', async () => {
    const { client, mocks } = insertClient([{ id: 7 }]);

    await insertProposal({ ...baseInput, action: undefined }, client);

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ action: null }));
  });
});

// ── getPendingProposals ───────────────────────────────────────────────────────

describe('getPendingProposals', () => {
  it('returns proposals from findMany', async () => {
    const rows = [{ id: 1, status: 'pending' }, { id: 2, status: 'pending' }];
    const { client, mocks } = findManyClient(rows);

    const result = await getPendingProposals(1, client);

    expect(result).toEqual(rows);
    expect(mocks.findMany).toHaveBeenCalledOnce();
  });

  it('returns an empty array when the org has no pending proposals', async () => {
    const { client } = findManyClient([]);

    expect(await getPendingProposals(99, client)).toEqual([]);
  });
});

// ── getRecentDedupKeys ────────────────────────────────────────────────────────

describe('getRecentDedupKeys', () => {
  it('maps selected rows to dedup key strings', async () => {
    const { client } = selectClient([
      { dedupKey: 'cash_flow:burn_rate:default' },
      { dedupKey: 'revenue:growth:q2' },
    ]);

    const result = await getRecentDedupKeys(1, new Date('2026-06-22'), client);

    expect(result).toEqual(['cash_flow:burn_rate:default', 'revenue:growth:q2']);
  });

  it('returns an empty array when no recent proposals exist', async () => {
    const { client } = selectClient([]);

    expect(await getRecentDedupKeys(1, new Date(), client)).toEqual([]);
  });
});

// ── resolveProposal ───────────────────────────────────────────────────────────

describe('resolveProposal', () => {
  it('returns { id, orgId } when a pending proposal is resolved', async () => {
    const { client, mocks } = updateReturningClient([{ id: 5, orgId: 1 }]);

    const result = await resolveProposal(5, 'approved', 99, client);

    expect(result).toEqual({ id: 5, orgId: 1 });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', resolvedByUserId: 99 }),
    );
  });

  it('returns null when no pending proposal matches (already resolved or wrong id)', async () => {
    const { client } = updateReturningClient([]);

    expect(await resolveProposal(5, 'rejected', 99, client)).toBeNull();
  });

  it('passes rejected status correctly', async () => {
    const { client, mocks } = updateReturningClient([{ id: 3, orgId: 2 }]);

    await resolveProposal(3, 'rejected', 12, client);

    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
  });
});

// ── markNotified ──────────────────────────────────────────────────────────────

describe('markNotified', () => {
  it('updates proposals to notified status scoped to the org', async () => {
    const { client, mocks } = updateNoReturnClient();

    await markNotified(1, [1, 2, 3], client);

    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'notified' }),
    );
  });

  it('skips the update entirely when ids is empty', async () => {
    const { client, mocks } = updateNoReturnClient();

    await markNotified(1, [], client);

    expect(mocks.update).not.toHaveBeenCalled();
  });
});

// ── expireProposals ───────────────────────────────────────────────────────────

describe('expireProposals', () => {
  it('returns the ids of proposals that were expired', async () => {
    const { client, mocks } = updateReturningClient([{ id: 10 }, { id: 11 }]);

    const result = await expireProposals(new Date('2026-07-06'), client);

    expect(result).toEqual([10, 11]);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('returns an empty array when no proposals are past their expiry', async () => {
    const { client } = updateReturningClient([]);

    expect(await expireProposals(new Date(), client)).toEqual([]);
  });
});
