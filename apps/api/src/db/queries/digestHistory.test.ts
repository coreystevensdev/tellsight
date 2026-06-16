import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockInsertValues = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }));
const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {
    query: { digestHistory: { findFirst: mockFindFirst, findMany: mockFindMany } },
    insert: mockInsert,
  },
}));

const { getLastDigest, getTrailingDigests, saveDigestHistory } = await import('./digestHistory.js');

const sampleInput = {
  orgId: 3,
  datasetId: 11,
  summaryId: 42,
  weekStart: new Date('2026-05-25T00:00:00Z'),
  subjectLine: 'Revenue up, watch payroll',
  stateSentence: 'You took in more than you spent this week.',
  valence: 'positive' as const,
  keyStats: [],
  milestones: [],
  sentAt: new Date('2026-05-25T13:00:00Z'),
};

beforeEach(() => {
  mockFindFirst.mockReset();
  mockFindMany.mockReset();
  mockOnConflictDoNothing.mockReset().mockResolvedValue(undefined);
  mockInsertValues.mockClear();
  mockInsert.mockClear();
});

describe('getLastDigest', () => {
  it('returns the most recent row for the org', async () => {
    const row = { id: 5, orgId: 3, weekStart: new Date('2026-05-25T00:00:00Z') };
    mockFindFirst.mockResolvedValueOnce(row);

    const result = await getLastDigest(3);

    expect(result).toEqual(row);
    expect(mockFindFirst).toHaveBeenCalledOnce();
  });

  it('returns undefined when the org has no history', async () => {
    mockFindFirst.mockResolvedValueOnce(undefined);

    expect(await getLastDigest(99)).toBeUndefined();
  });
});

describe('getTrailingDigests', () => {
  it('returns up to `limit` rows newest-first', async () => {
    const rows = [
      { id: 9, weekStart: new Date('2026-05-25T00:00:00Z') },
      { id: 8, weekStart: new Date('2026-05-18T00:00:00Z') },
    ];
    mockFindMany.mockResolvedValueOnce(rows);

    const result = await getTrailingDigests(3, 4);

    expect(result).toEqual(rows);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 4 }),
    );
  });

  it('returns an empty array when the org has no history', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    expect(await getTrailingDigests(99, 4)).toEqual([]);
  });
});

describe('saveDigestHistory', () => {
  it('inserts one row from the input', async () => {
    await saveDigestHistory(sampleInput);

    expect(mockInsert).toHaveBeenCalledOnce();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 3, valence: 'positive', sentAt: sampleInput.sentAt }),
    );
  });

  it('defers double-write protection to the (org, week) unique index', async () => {
    await saveDigestHistory(sampleInput);

    expect(mockOnConflictDoNothing).toHaveBeenCalledOnce();
    // target must be the column refs of the unique index, not the index name
    expect(mockOnConflictDoNothing).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.any(Array) }),
    );
  });
});
