import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const mockSelect = vi.fn();
const mockSelectDistinct = vi.fn();

function chainable(resolvedValue: unknown) {
  const chain: Record<string, Mock> = {};
  chain.as = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.groupBy = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.then = vi.fn().mockImplementation((resolve) => resolve(resolvedValue));
  // make it thenable so await works
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

vi.mock('../../lib/db.js', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
  },
}));

const { getChartData } = await import('./charts.js');

function aggRow(overrides: {
  bucket: string;
  parentCategory: string;
  category: string;
  total: string;
  year?: string;
  monthIdx?: string;
}) {
  return {
    bucket: overrides.bucket,
    parentCategory: overrides.parentCategory,
    category: overrides.category,
    total: overrides.total,
    year: overrides.year ?? overrides.bucket.split('-')[0]!,
    monthIdx: overrides.monthIdx ?? String(parseInt(overrides.bucket.split('-')[1]!, 10) - 1),
  };
}

describe('getChartData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMocks(metaResult: unknown[], aggResult: unknown[]) {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      return chainable(callCount === 1 ? metaResult : aggResult);
    });
  }

  it('aggregates income rows into monthly revenue', async () => {
    setupMocks(
      [{ minDate: '2025-01-10', maxDate: '2025-02-05' }],
      [
        aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1500.00', monthIdx: '0' }),
        aggRow({ bucket: '2025-02', parentCategory: 'Income', category: 'Sales', total: '750.00', monthIdx: '1' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([
      { month: 'Jan 2025', revenue: 1500 },
      { month: 'Feb 2025', revenue: 750 },
    ]);
  });

  it('aggregates expense rows by category sorted descending', async () => {
    setupMocks(
      [{ minDate: '2025-01-01', maxDate: '2025-02-01' }],
      [
        aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Rent', total: '200.00', monthIdx: '0' }),
        aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Payroll', total: '800.00', monthIdx: '0' }),
        aggRow({ bucket: '2025-02', parentCategory: 'Expenses', category: 'Rent', total: '300.00', monthIdx: '1' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.expenseBreakdown).toEqual([
      { category: 'Payroll', total: 800 },
      { category: 'Rent', total: 500 },
    ]);
  });

  it('returns empty arrays and null dateRange for no data', async () => {
    setupMocks([{ minDate: null, maxDate: null }], []);

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([]);
    expect(result.expenseBreakdown).toEqual([]);
    expect(result.availableCategories).toEqual([]);
    expect(result.dateRange).toBeNull();
  });

  it('handles rows with zero amounts', async () => {
    setupMocks(
      [{ minDate: '2025-03-15', maxDate: '2025-03-20' }],
      [
        aggRow({ bucket: '2025-03', parentCategory: 'Income', category: 'Sales', total: '0.00', monthIdx: '2' }),
        aggRow({ bucket: '2025-03', parentCategory: 'Expenses', category: 'Rent', total: '0.00', monthIdx: '2' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([{ month: 'Mar 2025', revenue: 0 }]);
    expect(result.expenseBreakdown).toEqual([{ category: 'Rent', total: 0 }]);
  });

  it('separates income and expense rows correctly', async () => {
    setupMocks(
      [{ minDate: '2025-04-05', maxDate: '2025-04-20' }],
      [
        aggRow({ bucket: '2025-04', parentCategory: 'Income', category: 'Sales', total: '5000.00', monthIdx: '3' }),
        aggRow({ bucket: '2025-04', parentCategory: 'Income', category: 'Consulting', total: '2000.00', monthIdx: '3' }),
        aggRow({ bucket: '2025-04', parentCategory: 'Expenses', category: 'Payroll', total: '1200.00', monthIdx: '3' }),
        aggRow({ bucket: '2025-04', parentCategory: 'Expenses', category: 'Utilities', total: '400.00', monthIdx: '3' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([{ month: 'Apr 2025', revenue: 7000 }]);
    expect(result.expenseBreakdown).toEqual([
      { category: 'Payroll', total: 1200 },
      { category: 'Utilities', total: 400 },
    ]);
  });

  it('rounds amounts to 2 decimal places', async () => {
    setupMocks(
      [{ minDate: '2025-06-05', maxDate: '2025-07-15' }],
      [
        aggRow({ bucket: '2025-06', parentCategory: 'Income', category: 'Sales', total: '99.99', monthIdx: '5' }),
        aggRow({ bucket: '2025-07', parentCategory: 'Expenses', category: 'Supplies', total: '20.01', monthIdx: '6' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([{ month: 'Jun 2025', revenue: 99.99 }]);
    expect(result.expenseBreakdown).toEqual([{ category: 'Supplies', total: 20.01 }]);
  });

  it('separates same month across different years', async () => {
    setupMocks(
      [{ minDate: '2025-01-10', maxDate: '2026-01-15' }],
      [
        aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1000.00', year: '2025', monthIdx: '0' }),
        aggRow({ bucket: '2026-01', parentCategory: 'Income', category: 'Sales', total: '2000.00', year: '2026', monthIdx: '0' }),
      ],
    );

    const result = await getChartData(1);

    expect(result.revenueTrend).toEqual([
      { month: 'Jan 2025', revenue: 1000 },
      { month: 'Jan 2026', revenue: 2000 },
    ]);
  });

  describe('metadata', () => {
    it('returns sorted availableCategories from expense rows', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-01-15' }],
        [
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Utilities', total: '100', monthIdx: '0' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Payroll', total: '200', monthIdx: '0' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Rent', total: '300', monthIdx: '0' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1000', monthIdx: '0' }),
        ],
      );

      const result = await getChartData(1);

      expect(result.availableCategories).toEqual(['Payroll', 'Rent', 'Utilities']);
    });

    it('returns dateRange from metadata query', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-06-30' }],
        [],
      );

      const result = await getChartData(1);

      expect(result.dateRange).toEqual({ min: '2025-01-01', max: '2025-06-30' });
    });
  });

  describe('filters', () => {
    it('filters expenses by category', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-03-15' }],
        [
          aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1000', monthIdx: '0' }),
          aggRow({ bucket: '2025-02', parentCategory: 'Income', category: 'Sales', total: '2000', monthIdx: '1' }),
          aggRow({ bucket: '2025-03', parentCategory: 'Income', category: 'Sales', total: '3000', monthIdx: '2' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Rent', total: '500', monthIdx: '0' }),
          aggRow({ bucket: '2025-02', parentCategory: 'Expenses', category: 'Payroll', total: '800', monthIdx: '1' }),
          aggRow({ bucket: '2025-03', parentCategory: 'Expenses', category: 'Utilities', total: '300', monthIdx: '2' }),
        ],
      );

      const result = await getChartData(1, { categories: ['Rent'] });

      expect(result.revenueTrend).toHaveLength(3);
      expect(result.expenseBreakdown).toEqual([{ category: 'Rent', total: 500 }]);
    });

    it('fetches unfiltered categories when date filters are active', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-03-15' }],
        [
          aggRow({ bucket: '2025-02', parentCategory: 'Expenses', category: 'Payroll', total: '800', monthIdx: '1' }),
        ],
      );
      mockSelectDistinct.mockImplementation(() =>
        chainable([{ category: 'Payroll' }, { category: 'Rent' }, { category: 'Utilities' }]),
      );

      const result = await getChartData(1, {
        dateFrom: new Date('2025-02-01'),
        dateTo: new Date('2025-02-28'),
      });

      expect(result.availableCategories).toEqual(['Payroll', 'Rent', 'Utilities']);
      expect(mockSelectDistinct).toHaveBeenCalled();
    });
  });

  describe('monthlyComparison', () => {
    it('computes revenue minus expenses as profit', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-01-31' }],
        [
          aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '5000', monthIdx: '0' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Rent', total: '1200', monthIdx: '0' }),
          aggRow({ bucket: '2025-01', parentCategory: 'Expenses', category: 'Payroll', total: '800', monthIdx: '0' }),
        ],
      );

      const result = await getChartData(1);

      expect(result.monthlyComparison).toEqual([
        { month: 'Jan 2025', revenue: 5000, expenses: 2000, profit: 3000 },
      ]);
    });
  });

  describe('yoyComparison', () => {
    it('compares revenue across two years', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2026-02-28' }],
        [
          aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1000', year: '2025', monthIdx: '0' }),
          aggRow({ bucket: '2025-02', parentCategory: 'Income', category: 'Sales', total: '1500', year: '2025', monthIdx: '1' }),
          aggRow({ bucket: '2026-01', parentCategory: 'Income', category: 'Sales', total: '1200', year: '2026', monthIdx: '0' }),
          aggRow({ bucket: '2026-02', parentCategory: 'Income', category: 'Sales', total: '1800', year: '2026', monthIdx: '1' }),
        ],
      );

      const result = await getChartData(1);

      expect(result.yoyComparison).toHaveLength(2);
      expect(result.yoyComparison[0]).toMatchObject({
        month: 'Jan',
        currentYear: 1200,
        priorYear: 1000,
        currentYearLabel: '2026',
        priorYearLabel: '2025',
      });
      expect(result.yoyComparison[0]!.changePercent).toBe(20);
    });

    it('returns empty when less than 2 years of data', async () => {
      setupMocks(
        [{ minDate: '2025-01-01', maxDate: '2025-06-30' }],
        [
          aggRow({ bucket: '2025-01', parentCategory: 'Income', category: 'Sales', total: '1000', monthIdx: '0' }),
        ],
      );

      const result = await getChartData(1);

      expect(result.yoyComparison).toEqual([]);
    });
  });
});
