import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetRowsByDataset = vi.fn();
const mockGetBusinessProfile = vi.fn();
const mockGetActiveCorrectionStatIds = vi.fn();
const mockGetTrailingDigests = vi.fn();

vi.mock('../../db/queries/index.js', () => ({
  dataRowsQueries: {
    getRowsByDataset: (...args: unknown[]) => mockGetRowsByDataset(...args),
  },
  orgsQueries: {
    getBusinessProfile: (...args: unknown[]) => mockGetBusinessProfile(...args),
  },
  statCorrectionsQueries: {
    getActiveCorrectionStatIds: (...args: unknown[]) => mockGetActiveCorrectionStatIds(...args),
  },
  digestHistoryQueries: {
    getTrailingDigests: (...args: unknown[]) => mockGetTrailingDigests(...args),
  },
}));

vi.mock('../../lib/rls.js', () => ({
  withRlsContext: vi.fn((_orgId: number, _isAdmin: boolean, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getMetricWithTrend,
  compareToPriorPeriods,
  GET_METRIC_WITH_TREND_TOOL,
  COMPARE_TO_PRIOR_PERIODS_TOOL,
  TREND_CARRYING_STAT_TYPES,
} from './interpretationTools.js';
import { computeStats, assignIds, statInstanceId } from './computation.js';
import { StatType } from './types.js';

const ORG_ID = 1;
const DATASET_ID = 7;

let _rowId = 1;
function row(category: string, date: Date, amount: number) {
  return {
    id: _rowId++,
    orgId: ORG_ID,
    datasetId: DATASET_ID,
    sourceType: 'csv' as const,
    category,
    parentCategory: null,
    date,
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

// 4 months of rising Sales, enough points for computeTrends' default
// trendMinPoints of 3 (scoring-weights.json).
const salesRows = [
  row('Sales', new Date(2026, 0, 15), 1000),
  row('Sales', new Date(2026, 1, 15), 1200),
  row('Sales', new Date(2026, 2, 15), 1400),
  row('Sales', new Date(2026, 3, 15), 1600),
];

function ccfRow(parentCategory: 'Income' | 'Expenses', month: number, amount: number) {
  return {
    id: _rowId++,
    orgId: ORG_ID,
    datasetId: DATASET_ID,
    sourceType: 'csv' as const,
    category: parentCategory === 'Income' ? 'Revenue' : 'COGS',
    parentCategory,
    date: new Date(Date.UTC(2026, month - 1, 1)),
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

// 3 months burning at -4000/mo, comfortably outside the near-zero
// suppression band (5% of avg revenue) so computeCashFlow emits a stat.
const cashFlowRows = [1, 2, 3].flatMap((month) => [ccfRow('Income', month, 8000), ccfRow('Expenses', month, 12000)]);

// Day 15 (not day 1, like ccfRow uses elsewhere), and a local Date rather
// than Date.UTC, so this can't roll over into the neighboring month when
// read back through row.date.getMonth() at UTC offsets west of UTC.
function incomeRow(year: number, month: number, amount: number) {
  return {
    id: _rowId++,
    orgId: ORG_ID,
    datasetId: DATASET_ID,
    sourceType: 'csv' as const,
    category: 'Revenue',
    parentCategory: 'Income' as const,
    date: new Date(year, month - 1, 15),
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

// Jan and Mar 2026 both clear computeYearOverYear's 3% significance threshold
// vs. 2025; Feb doesn't -- gives two YearOverYear/Revenue instances with
// different discriminators (currentYear-month), Mar being the most recent.
const twoYearRevenueRows = [
  incomeRow(2025, 1, 1000),
  incomeRow(2025, 2, 1000),
  incomeRow(2025, 3, 1000),
  incomeRow(2026, 1, 1200),
  incomeRow(2026, 2, 1000),
  incomeRow(2026, 3, 1500),
];

function findSalesTrendId(): string {
  const identified = assignIds(computeStats(salesRows), DATASET_ID);
  const trend = identified.find((s) => s.statType === StatType.Trend && s.category === 'Sales');
  if (!trend) throw new Error('fixture did not produce a Sales trend stat');
  return trend.id;
}

const ctx = { orgId: ORG_ID, isAdmin: false, datasetId: DATASET_ID };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetRowsByDataset.mockResolvedValue(salesRows);
  mockGetBusinessProfile.mockResolvedValue(null);
  mockGetActiveCorrectionStatIds.mockResolvedValue([]);
  mockGetTrailingDigests.mockResolvedValue([]);
});

describe('tool schemas', () => {
  it('get_metric_with_trend restricts statType to the trend-carrying enum, excluding total and average', () => {
    const enumValues = (GET_METRIC_WITH_TREND_TOOL.inputSchema.properties as Record<string, { enum?: string[] }>).statType!.enum;
    expect(enumValues).toEqual([...TREND_CARRYING_STAT_TYPES]);
    expect(enumValues).not.toContain(StatType.Total);
    expect(enumValues).not.toContain(StatType.Average);
  });

  it('compare_to_prior_periods restricts statType the same way', () => {
    const enumValues = (COMPARE_TO_PRIOR_PERIODS_TOOL.inputSchema.properties as Record<string, { enum?: string[] }>).statType!.enum;
    expect(enumValues).toEqual([...TREND_CARRYING_STAT_TYPES]);
  });

  it('neither schema exposes orgId, isAdmin, or datasetId to the model', () => {
    for (const tool of [GET_METRIC_WITH_TREND_TOOL, COMPARE_TO_PRIOR_PERIODS_TOOL]) {
      const props = Object.keys(tool.inputSchema.properties as Record<string, unknown>);
      expect(props).not.toContain('orgId');
      expect(props).not.toContain('isAdmin');
      expect(props).not.toContain('datasetId');
    }
  });
});

describe('getMetricWithTrend', () => {
  it('resolves a trend-carrying stat for a matching statType and category, carrying its instance id', async () => {
    const result = await getMetricWithTrend({ statType: StatType.Trend, category: 'Sales' }, ctx);

    expect(result).not.toBeNull();
    expect(result!.statType).toBe(StatType.Trend);
    expect(result!.category).toBe('Sales');
    expect(result!.id).toBe(findSalesTrendId());
    expect(mockGetRowsByDataset).toHaveBeenCalledWith(ORG_ID, DATASET_ID, {});
  });

  it('returns null when no stat matches the requested statType and category', async () => {
    const result = await getMetricWithTrend({ statType: StatType.MarginTrend, category: 'NonExistent' }, ctx);
    expect(result).toBeNull();
  });

  it('excludes a stat with an active correction', async () => {
    mockGetActiveCorrectionStatIds.mockResolvedValue([findSalesTrendId()]);

    const result = await getMetricWithTrend({ statType: StatType.Trend, category: 'Sales' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null when the row fetch comes back empty, the shape an RLS-scoped cross-tenant read produces', async () => {
    mockGetRowsByDataset.mockResolvedValueOnce([]);

    const result = await getMetricWithTrend({ statType: StatType.Trend, category: 'Sales' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null for a non-positive or non-integer datasetId without querying', async () => {
    for (const datasetId of [0, -1, 1.5]) {
      const result = await getMetricWithTrend({ statType: StatType.Trend, category: 'Sales' }, { ...ctx, datasetId });
      expect(result).toBeNull();
    }
    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
  });

  it('returns null when a category-scoped statType is requested with no category', async () => {
    const result = await getMetricWithTrend({ statType: StatType.Trend }, ctx);
    expect(result).toBeNull();
    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
  });

  it('ignores a category supplied alongside an org-wide statType instead of failing to match', async () => {
    mockGetRowsByDataset.mockResolvedValue(cashFlowRows);

    const result = await getMetricWithTrend({ statType: StatType.CashFlow, category: 'Sales' }, ctx);
    expect(result).not.toBeNull();
    expect(result!.statType).toBe(StatType.CashFlow);
  });
});

describe('compareToPriorPeriods', () => {
  it('marks hasHistory: false rather than fabricating a series when there are fewer than 2 trailing digests', async () => {
    mockGetTrailingDigests.mockResolvedValue([{ weekStart: new Date('2026-04-06'), keyStats: [] }]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);

    expect(result).toEqual({ current: expect.objectContaining({ id: findSalesTrendId() }), hasHistory: false });
  });

  it('marks hasHistory: false with zero trailing digests', async () => {
    mockGetTrailingDigests.mockResolvedValue([]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);

    expect(result).toEqual({ current: expect.objectContaining({ id: findSalesTrendId() }), hasHistory: false });
  });

  it('builds a prior-period series from trailing digests that contain a matching stat', async () => {
    const trendStat = { statType: StatType.Trend, category: 'Sales', value: 150, details: { slope: 150, intercept: 0, growthPercent: 50, dataPoints: 4, firstValue: 1000, lastValue: 1600 } };
    mockGetTrailingDigests.mockResolvedValue([
      { weekStart: new Date('2026-04-06'), keyStats: [trendStat] },
      { weekStart: new Date('2026-03-30'), keyStats: [{ ...trendStat, value: 100 }] },
      { weekStart: new Date('2026-03-23'), keyStats: [] }, // no matching stat that week
    ]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales', periodsBack: 3 }, ctx);

    expect(result).toEqual({
      current: expect.objectContaining({ id: findSalesTrendId() }),
      hasHistory: true,
      priorPeriods: [
        { weekStart: new Date('2026-04-06').toISOString(), value: 150 },
        { weekStart: new Date('2026-03-30').toISOString(), value: 100 },
      ],
    });
    expect(mockGetTrailingDigests).toHaveBeenCalledWith(ORG_ID, 3, {});
  });

  it('excludes a prior-period match with an active correction even when the current stat is a different, unaffected instance', async () => {
    mockGetRowsByDataset.mockResolvedValue(twoYearRevenueRows);

    const januaryYoy = {
      statType: StatType.YearOverYear,
      category: 'Revenue',
      value: 1200,
      comparison: 1000,
      details: { currentYear: 2026, priorYear: 2025, currentYearLabel: '2026', priorYearLabel: '2025', changePercent: 20, month: 'Jan' },
    };
    mockGetActiveCorrectionStatIds.mockResolvedValue([statInstanceId(januaryYoy, DATASET_ID)]);
    mockGetTrailingDigests.mockResolvedValue([
      { weekStart: new Date('2026-04-06'), keyStats: [januaryYoy] },
      { weekStart: new Date('2026-03-30'), keyStats: [januaryYoy] },
    ]);

    const result = await compareToPriorPeriods({ statType: StatType.YearOverYear, category: 'Revenue' }, ctx);

    // current resolves to the March comparison (the most recent qualifying
    // month), a different instance id than the corrected January one, so the
    // live lookup is untouched -- only the corrected prior-period match is dropped.
    expect(result).toEqual({ current: expect.objectContaining({ value: 1500 }), hasHistory: false });
  });

  it('defaults periodsBack to 4 when omitted', async () => {
    await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);
    expect(mockGetTrailingDigests).toHaveBeenCalledWith(ORG_ID, 4, {});
  });

  it('returns null, not a hasHistory marker, when no stat matches the requested statType and category', async () => {
    const result = await compareToPriorPeriods({ statType: StatType.MarginTrend, category: 'NonExistent' }, ctx);
    expect(result).toBeNull();
  });

  it('excludes a stat with an active correction, returning null rather than a suppressed series', async () => {
    mockGetActiveCorrectionStatIds.mockResolvedValue([findSalesTrendId()]);
    mockGetTrailingDigests.mockResolvedValue([
      { weekStart: new Date('2026-04-06'), keyStats: [] },
      { weekStart: new Date('2026-03-30'), keyStats: [] },
    ]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null when the row fetch comes back empty, the shape an RLS-scoped cross-tenant read produces', async () => {
    mockGetRowsByDataset.mockResolvedValueOnce([]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null for a non-positive or non-integer datasetId without querying', async () => {
    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, { ...ctx, datasetId: 0 });
    expect(result).toBeNull();
    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
  });

  it('returns null when a category-scoped statType is requested with no category', async () => {
    const result = await compareToPriorPeriods({ statType: StatType.Trend }, ctx);
    expect(result).toBeNull();
    expect(mockGetRowsByDataset).not.toHaveBeenCalled();
  });

  it('marks hasHistory: false when 2+ trailing digests exist but none contain the requested stat', async () => {
    mockGetTrailingDigests.mockResolvedValue([
      { weekStart: new Date('2026-04-06'), keyStats: [] },
      { weekStart: new Date('2026-03-30'), keyStats: [] },
      { weekStart: new Date('2026-03-23'), keyStats: [] },
    ]);

    const result = await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales' }, ctx);

    expect(result).toEqual({ current: expect.objectContaining({ id: findSalesTrendId() }), hasHistory: false });
  });

  it('clamps periodsBack into the schema-documented 2-8 range instead of passing an out-of-range value to the query', async () => {
    await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales', periodsBack: 0 }, ctx);
    expect(mockGetTrailingDigests).toHaveBeenCalledWith(ORG_ID, 2, {});

    mockGetTrailingDigests.mockClear();
    await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales', periodsBack: 100 }, ctx);
    expect(mockGetTrailingDigests).toHaveBeenCalledWith(ORG_ID, 8, {});

    mockGetTrailingDigests.mockClear();
    await compareToPriorPeriods({ statType: StatType.Trend, category: 'Sales', periodsBack: Number.NaN }, ctx);
    expect(mockGetTrailingDigests).toHaveBeenCalledWith(ORG_ID, 4, {});
  });
});
