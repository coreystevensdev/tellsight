import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/db.js', () => ({ db: {}, dbAdmin: {} }));

const {
  createCorrection,
  getCorrectionsByDataset,
  resolveCorrection,
  getActiveCorrectionStatIds,
  expireCorrections,
} = await import('./statCorrections.js');

function insertClient(rows: unknown[], insertError?: unknown) {
  const returning = insertError
    ? vi.fn().mockRejectedValue(insertError)
    : vi.fn().mockResolvedValue(rows);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  return { client: { insert } as never, mocks: { insert, values, returning } };
}

function selectOrderByClient(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { client: { select } as never, mocks: { select, from, where, orderBy } };
}

function selectWhereClient(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { client: { select } as never, mocks: { select, from, where } };
}

function updateReturningClient(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { client: { update } as never, mocks: { update, set, where, returning } };
}

const baseInput = {
  orgId: 1,
  datasetId: 5,
  statInstanceId: '5:runway:_:_',
  userId: 9,
  note: 'This runway figure double-counts the SBA loan.',
  appliesGoingForward: false,
};

describe('createCorrection', () => {
  it('inserts a Tier 1 annotation with status null', async () => {
    const { client, mocks } = insertClient([{ id: 1 }]);

    await createCorrection(baseInput, client);

    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 1, statInstanceId: '5:runway:_:_', status: null }),
    );
  });

  it('inserts a Tier 2 request with status pending', async () => {
    const { client, mocks } = insertClient([{ id: 2 }]);

    await createCorrection({ ...baseInput, appliesGoingForward: true }, client);

    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ appliesGoingForward: true, status: 'pending' }),
    );
  });

  it('throws ConflictError when a unique_violation is raised', async () => {
    const { client } = insertClient([], { code: '23505' });

    await expect(createCorrection({ ...baseInput, appliesGoingForward: true }, client)).rejects.toThrow(
      'A pending or approved correction already exists for this stat',
    );
  });

  it('rethrows unrelated errors', async () => {
    const { client } = insertClient([], new Error('connection reset'));

    await expect(createCorrection(baseInput, client)).rejects.toThrow('connection reset');
  });
});

describe('getCorrectionsByDataset', () => {
  it('returns corrections ordered by createdAt', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    const { client } = selectOrderByClient(rows);

    const result = await getCorrectionsByDataset(1, 5, client);

    expect(result).toEqual(rows);
  });

  it('returns an empty array when the dataset has no corrections', async () => {
    const { client } = selectOrderByClient([]);

    expect(await getCorrectionsByDataset(1, 5, client)).toEqual([]);
  });
});

describe('resolveCorrection', () => {
  it('approves a pending correction and sets the computed expiresAt', async () => {
    const expiresAt = new Date('2026-08-22');
    const { client, mocks } = updateReturningClient([{ id: 3, orgId: 1 }]);

    const result = await resolveCorrection(3, 1, 9, { status: 'approved', expiresAt }, client);

    expect(result).toEqual({ id: 3, orgId: 1 });
    expect(mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', resolvedByUserId: 9, expiresAt }),
    );
  });

  it('rejects a pending correction without touching expiresAt', async () => {
    const { client, mocks } = updateReturningClient([{ id: 4, orgId: 1 }]);

    await resolveCorrection(4, 1, 9, { status: 'rejected' }, client);

    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(mocks.set).not.toHaveBeenCalledWith(expect.objectContaining({ expiresAt: expect.anything() }));
  });

  it('returns null when no pending correction matches (already resolved or wrong id)', async () => {
    const { client } = updateReturningClient([]);

    expect(await resolveCorrection(3, 1, 9, { status: 'rejected' }, client)).toBeNull();
  });
});

describe('getActiveCorrectionStatIds', () => {
  it('returns stat instance ids for approved corrections', async () => {
    const { client } = selectWhereClient([
      { statInstanceId: '5:runway:_:_' },
      { statInstanceId: '5:anomaly:Sales:v500' },
    ]);

    const result = await getActiveCorrectionStatIds(1, client);

    expect(result).toEqual(['5:runway:_:_', '5:anomaly:Sales:v500']);
  });

  it('returns an empty array when the org has no approved corrections', async () => {
    const { client } = selectWhereClient([]);

    expect(await getActiveCorrectionStatIds(1, client)).toEqual([]);
  });
});

describe('expireCorrections', () => {
  it('returns id, orgId, and datasetId for each correction that was expired', async () => {
    const rows = [
      { id: 10, orgId: 1, datasetId: 5 },
      { id: 11, orgId: 2, datasetId: 9 },
    ];
    const { client, mocks } = updateReturningClient(rows);

    const result = await expireCorrections(new Date('2026-08-22'), client);

    expect(result).toEqual(rows);
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
  });

  it('returns an empty array when nothing is past its expiry', async () => {
    const { client } = updateReturningClient([]);

    expect(await expireCorrections(new Date(), client)).toEqual([]);
  });
});
