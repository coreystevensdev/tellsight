import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
const mockValues = vi.fn().mockResolvedValue(undefined);
const mockSelectWhere = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();

vi.mock('../../lib/db.js', () => ({
  db: {
    query: {
      dataRows: {
        findMany: mockFindMany,
      },
    },
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockSelectWhere }),
    }),
  },
}));

const { insertBatch, getByDateRange, getByCategory, getRowsByDataset, getDateRange } =
  await import('./dataRows.js');

describe('dataRows queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('insertBatch', () => {
    it('inserts rows in batches', async () => {
      const rows = [
        { category: 'Revenue', date: new Date('2025-01-15'), amount: '12000.00' },
        { category: 'Payroll', date: new Date('2025-01-15'), amount: '5500.00' },
      ];

      await insertBatch(10, 1, rows);

      expect(mockValues).toHaveBeenCalledOnce();
      expect(mockValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ orgId: 10, datasetId: 1, category: 'Revenue' }),
        ]),
      );
    });

    it('skips insert for empty input', async () => {
      await insertBatch(10, 1, []);

      expect(mockValues).not.toHaveBeenCalled();
    });
  });

  describe('getByDateRange', () => {
    it('returns rows within date range', async () => {
      const rows = [{ id: 1, amount: '12000.00' }];
      mockFindMany.mockResolvedValueOnce(rows);

      const start = new Date('2025-01-01');
      const end = new Date('2025-03-31');
      const result = await getByDateRange(10, start, end);

      expect(mockFindMany).toHaveBeenCalledOnce();
      expect(result).toEqual(rows);
    });

    it('accepts optional datasetIds filter', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      const start = new Date('2025-01-01');
      const end = new Date('2025-12-31');
      await getByDateRange(10, start, end, [1, 2]);

      expect(mockFindMany).toHaveBeenCalledOnce();
    });
  });

  describe('getByCategory', () => {
    it('returns rows for the category', async () => {
      const rows = [{ id: 1, category: 'Revenue' }];
      mockFindMany.mockResolvedValueOnce(rows);

      const result = await getByCategory(10, 'Revenue');

      expect(mockFindMany).toHaveBeenCalledOnce();
      expect(result).toEqual(rows);
    });

    it('accepts optional datasetIds filter', async () => {
      mockFindMany.mockResolvedValueOnce([]);

      await getByCategory(10, 'Revenue', [1]);

      expect(mockFindMany).toHaveBeenCalledOnce();
    });
  });

  describe('getRowsByDataset', () => {
    it('returns rows for the dataset', async () => {
      const rows = [{ id: 1 }, { id: 2 }];
      mockFindMany.mockResolvedValueOnce(rows);

      const result = await getRowsByDataset(10, 1);

      expect(mockFindMany).toHaveBeenCalledOnce();
      expect(result).toEqual(rows);
    });
  });

  describe('getDateRange', () => {
    it('returns the earliest/latest date as Date objects', async () => {
      mockSelectWhere.mockResolvedValueOnce([
        { earliest: '2026-01-01', latest: '2026-06-15' },
      ]);

      const result = await getDateRange(10, 1);

      expect(result).toEqual({
        earliest: new Date('2026-01-01'),
        latest: new Date('2026-06-15'),
      });
    });

    it('returns null when the dataset has no rows', async () => {
      mockSelectWhere.mockResolvedValueOnce([{ earliest: null, latest: null }]);

      const result = await getDateRange(10, 1);

      expect(result).toBeNull();
    });
  });
});
