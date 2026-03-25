import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();

vi.mock('../../lib/db.js', () => ({
  db: {
    query: {
      dataRows: { findMany: mockFindMany },
    },
  },
}));

const { getChartData } = await import('./charts.js');

function row(overrides: {
  date: Date;
  amount: string;
  category: string;
  parentCategory: string;
}) {
  return { orgId: 1, ...overrides };
}

describe('getChartData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates income rows into monthly revenue', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date('2025-01-10'), amount: '1000.00', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2025-01-20'), amount: '500.00', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2025-02-05'), amount: '750.00', category: 'Sales', parentCategory: 'Income' }),
    ]);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([
      { month: 'Jan 2025', revenue: 1500 },
      { month: 'Feb 2025', revenue: 750 },
    ]);
  });

  it('aggregates expense rows by category sorted descending', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date('2025-01-01'), amount: '200.00', category: 'Rent', parentCategory: 'Expenses' }),
      row({ date: new Date('2025-01-15'), amount: '800.00', category: 'Payroll', parentCategory: 'Expenses' }),
      row({ date: new Date('2025-02-01'), amount: '300.00', category: 'Rent', parentCategory: 'Expenses' }),
    ]);

    const result = await getChartData(1);

    expect(result.expenseBreakdown).toEqual([
      { category: 'Payroll', total: 800 },
      { category: 'Rent', total: 500 },
    ]);
  });

  it('returns empty arrays and null dateRange for no data', async () => {
    mockFindMany.mockResolvedValueOnce([]);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([]);
    expect(result.expenseBreakdown).toEqual([]);
    expect(result.availableCategories).toEqual([]);
    expect(result.dateRange).toBeNull();
  });

  it('handles rows with zero amounts', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date(2025, 2, 15), amount: '0.00', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date(2025, 2, 20), amount: '0.00', category: 'Rent', parentCategory: 'Expenses' }),
    ]);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([{ month: 'Mar 2025', revenue: 0 }]);
    expect(result.expenseBreakdown).toEqual([{ category: 'Rent', total: 0 }]);
  });

  it('separates income and expense rows correctly', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date(2025, 3, 5), amount: '5000.00', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date(2025, 3, 10), amount: '1200.00', category: 'Payroll', parentCategory: 'Expenses' }),
      row({ date: new Date(2025, 3, 15), amount: '2000.00', category: 'Consulting', parentCategory: 'Income' }),
      row({ date: new Date(2025, 3, 20), amount: '400.00', category: 'Utilities', parentCategory: 'Expenses' }),
    ]);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([{ month: 'Apr 2025', revenue: 7000 }]);
    expect(result.expenseBreakdown).toEqual([
      { category: 'Payroll', total: 1200 },
      { category: 'Utilities', total: 400 },
    ]);
  });

  it('rounds amounts to 2 decimal places', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date(2025, 5, 5), amount: '33.33', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date(2025, 5, 15), amount: '33.33', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date(2025, 5, 20), amount: '33.33', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date(2025, 6, 5), amount: '10.005', category: 'Supplies', parentCategory: 'Expenses' }),
      row({ date: new Date(2025, 6, 15), amount: '10.005', category: 'Supplies', parentCategory: 'Expenses' }),
    ]);

    const result = await getChartData(1);

    // 33.33 * 3 = 99.99 — already clean, but verifies rounding path runs
    expect(result.revenueTrend).toEqual([{ month: 'Jun 2025', revenue: 99.99 }]);
    // 10.005 + 10.005 = 20.01 after rounding
    expect(result.expenseBreakdown).toEqual([{ category: 'Supplies', total: 20.01 }]);
  });

  it('separates same month across different years', async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ date: new Date('2025-01-10'), amount: '1000.00', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2026-01-15'), amount: '2000.00', category: 'Sales', parentCategory: 'Income' }),
    ]);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([
      { month: 'Jan 2025', revenue: 1000 },
      { month: 'Jan 2026', revenue: 2000 },
    ]);
  });

  it('passes default limit to findMany', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await getChartData(1);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2000 }),
    );
  });

  it('accepts custom limit override', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await getChartData(1, undefined, 500);

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 500 }),
    );
  });

  describe('metadata', () => {
    it('returns sorted availableCategories from expense rows', async () => {
      mockFindMany.mockResolvedValueOnce([
        row({ date: new Date('2025-01-01'), amount: '100', category: 'Utilities', parentCategory: 'Expenses' }),
        row({ date: new Date('2025-01-05'), amount: '200', category: 'Payroll', parentCategory: 'Expenses' }),
        row({ date: new Date('2025-01-10'), amount: '300', category: 'Rent', parentCategory: 'Expenses' }),
        row({ date: new Date('2025-01-15'), amount: '1000', category: 'Sales', parentCategory: 'Income' }),
      ]);

      const result = await getChartData(1);

      expect(result.availableCategories).toEqual(['Payroll', 'Rent', 'Utilities']);
    });

    it('returns dateRange spanning all rows', async () => {
      mockFindMany.mockResolvedValueOnce([
        row({ date: new Date('2025-03-15'), amount: '100', category: 'Sales', parentCategory: 'Income' }),
        row({ date: new Date('2025-01-01'), amount: '200', category: 'Rent', parentCategory: 'Expenses' }),
        row({ date: new Date('2025-06-30'), amount: '300', category: 'Payroll', parentCategory: 'Expenses' }),
      ]);

      const result = await getChartData(1);

      expect(result.dateRange).toEqual({ min: '2025-01-01', max: '2025-06-30' });
    });
  });

  describe('filters', () => {
    const mixedRows = [
      row({ date: new Date('2025-01-10'), amount: '1000', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2025-02-15'), amount: '2000', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2025-03-20'), amount: '3000', category: 'Sales', parentCategory: 'Income' }),
      row({ date: new Date('2025-01-05'), amount: '500', category: 'Rent', parentCategory: 'Expenses' }),
      row({ date: new Date('2025-02-10'), amount: '800', category: 'Payroll', parentCategory: 'Expenses' }),
      row({ date: new Date('2025-03-15'), amount: '300', category: 'Utilities', parentCategory: 'Expenses' }),
    ];

    it('filters revenue by date range', async () => {
      mockFindMany.mockResolvedValueOnce(mixedRows);

      const result = await getChartData(1, {
        dateFrom: new Date('2025-02-01'),
        dateTo: new Date('2025-02-28'),
      });

      expect(result.revenueTrend).toEqual([{ month: 'Feb 2025', revenue: 2000 }]);
      expect(result.expenseBreakdown).toEqual([{ category: 'Payroll', total: 800 }]);
    });

    it('filters expenses by category', async () => {
      mockFindMany.mockResolvedValueOnce(mixedRows);

      const result = await getChartData(1, { categories: ['Rent'] });

      // revenue unaffected by category filter
      expect(result.revenueTrend).toHaveLength(3);
      expect(result.expenseBreakdown).toEqual([{ category: 'Rent', total: 500 }]);
    });

    it('combines date and category filters', async () => {
      mockFindMany.mockResolvedValueOnce(mixedRows);

      const result = await getChartData(1, {
        dateFrom: new Date('2025-01-01'),
        dateTo: new Date('2025-02-28'),
        categories: ['Payroll', 'Rent'],
      });

      expect(result.revenueTrend).toEqual([
        { month: 'Jan 2025', revenue: 1000 },
        { month: 'Feb 2025', revenue: 2000 },
      ]);
      expect(result.expenseBreakdown).toEqual([
        { category: 'Payroll', total: 800 },
        { category: 'Rent', total: 500 },
      ]);
    });

    it('metadata reflects full dataset regardless of filters', async () => {
      mockFindMany.mockResolvedValueOnce(mixedRows);

      const result = await getChartData(1, {
        dateFrom: new Date('2025-02-01'),
        dateTo: new Date('2025-02-28'),
        categories: ['Rent'],
      });

      expect(result.availableCategories).toEqual(['Payroll', 'Rent', 'Utilities']);
      expect(result.dateRange).toEqual({ min: '2025-01-05', max: '2025-03-20' });
    });
  });
});
