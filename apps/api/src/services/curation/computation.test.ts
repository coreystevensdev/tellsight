import { describe, it, expect } from 'vitest';

import {
  computeStats,
  computeRunway,
  runwayConfidence,
  computeBreakEven,
  breakEvenConfidence,
  computeCashForecast,
  monthlyNetsWindow,
  bucketRowsByMonth,
  cashFlowFromBuckets,
  cashFlowForAlerting,
  netsFromBuckets,
  resolveStatById,
  resolveStatByType,
  assignIds,
  monthKey,
  marginTrendMonths,
  type MonthlyBucketMap,
} from './computation.js';
import type {
  ComputedStat,
  CashFlowStat,
  RunwayStat,
  BreakEvenStat,
  CashForecastStat,
  MarginTrendStat,
  YearOverYearStat,
  SeasonalProjectionStat,
} from './types.js';
import { StatType } from './types.js';

const fixture = {
  multiCategory: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-01-01'), amount: '1000.00', label: 'Widget A', metadata: null, createdAt: new Date() },
    { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-02-01'), amount: '1500.00', label: 'Widget B', metadata: null, createdAt: new Date() },
    { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-03-01'), amount: '2000.00', label: 'Widget C', metadata: null, createdAt: new Date() },
    { id: 4, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-04-01'), amount: '2500.00', label: 'Widget D', metadata: null, createdAt: new Date() },
    { id: 5, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Marketing', parentCategory: null, date: new Date('2026-01-01'), amount: '500.00', label: 'Ad spend', metadata: null, createdAt: new Date() },
    { id: 6, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Marketing', parentCategory: null, date: new Date('2026-02-01'), amount: '600.00', label: 'Ad spend', metadata: null, createdAt: new Date() },
    { id: 7, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Marketing', parentCategory: null, date: new Date('2026-03-01'), amount: '550.00', label: 'Ad spend', metadata: null, createdAt: new Date() },
    { id: 8, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Marketing', parentCategory: null, date: new Date('2026-04-01'), amount: '700.00', label: 'Ad spend', metadata: null, createdAt: new Date() },
  ],

  singleRow: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Refunds', parentCategory: null, date: new Date('2026-01-01'), amount: '250.00', label: 'Return', metadata: null, createdAt: new Date() },
  ],

  withAnomaly: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Revenue', parentCategory: null, date: new Date('2026-01-01'), amount: '100.00', label: null, metadata: null, createdAt: new Date() },
    { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Revenue', parentCategory: null, date: new Date('2026-02-01'), amount: '105.00', label: null, metadata: null, createdAt: new Date() },
    { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Revenue', parentCategory: null, date: new Date('2026-03-01'), amount: '98.00', label: null, metadata: null, createdAt: new Date() },
    { id: 4, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Revenue', parentCategory: null, date: new Date('2026-04-01'), amount: '102.00', label: null, metadata: null, createdAt: new Date() },
    { id: 5, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Revenue', parentCategory: null, date: new Date('2026-05-01'), amount: '500.00', label: null, metadata: null, createdAt: new Date() },
  ],

  withNaN: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-01-01'), amount: 'not-a-number', label: null, metadata: null, createdAt: new Date() },
    { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-02-01'), amount: '100.00', label: null, metadata: null, createdAt: new Date() },
  ],

  negativeAmounts: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-01-01'), amount: '-200.00', label: null, metadata: null, createdAt: new Date() },
    { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-02-01'), amount: '-150.00', label: null, metadata: null, createdAt: new Date() },
    { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-03-01'), amount: '-300.00', label: null, metadata: null, createdAt: new Date() },
  ],

  allSameAmount: [
    { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Fees', parentCategory: null, date: new Date('2026-01-01'), amount: '50.00', label: null, metadata: null, createdAt: new Date() },
    { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Fees', parentCategory: null, date: new Date('2026-02-01'), amount: '50.00', label: null, metadata: null, createdAt: new Date() },
    { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Fees', parentCategory: null, date: new Date('2026-03-01'), amount: '50.00', label: null, metadata: null, createdAt: new Date() },
  ],
};

describe('computeStats', () => {
  it('returns empty array for empty dataset', () => {
    const result = computeStats([]);
    expect(result).toEqual([]);
  });

  it('produces totals for each category', () => {
    const stats = computeStats(fixture.multiCategory);
    const totals = stats.filter((s) => s.statType === StatType.Total);

    const salesTotals = totals.filter((s) => s.category === 'Sales');
    expect(salesTotals.length).toBeGreaterThanOrEqual(1);

    const salesTotal = salesTotals.find((s) => s.details.scope === 'category');
    expect(salesTotal?.value).toBe(7000);

    const marketingTotal = totals.find(
      (s) => s.category === 'Marketing' && s.details.scope === 'category',
    );
    expect(marketingTotal?.value).toBe(2350);
  });

  it('produces overall total', () => {
    const stats = computeStats(fixture.multiCategory);
    const overallTotal = stats.find(
      (s) => s.statType === StatType.Total && s.category === null,
    );
    expect(overallTotal?.value).toBe(9350);
  });

  it('produces averages for each category and overall', () => {
    const stats = computeStats(fixture.multiCategory);
    const avgs = stats.filter((s) => s.statType === StatType.Average);

    const salesAvg = avgs.find(
      (s) => s.category === 'Sales' && s.details.scope === 'category',
    );
    expect(salesAvg?.value).toBe(1750);

    const overallAvg = avgs.find((s) => s.category === null);
    expect(overallAvg?.value).toBeCloseTo(1168.75);
  });

  it('produces trends with slope for categories with ≥3 data points', () => {
    const stats = computeStats(fixture.multiCategory);
    const trends = stats.filter((s) => s.statType === StatType.Trend);

    const salesTrend = trends.find((s) => s.category === 'Sales');
    expect(salesTrend).toBeDefined();
    expect(salesTrend!.value).toBeGreaterThan(0);
    expect(salesTrend!.details).toHaveProperty('slope');
    expect(salesTrend!.details).toHaveProperty('growthPercent');
  });

  it('detects anomalies via IQR for categories with ≥3 data points', () => {
    const stats = computeStats(fixture.withAnomaly);
    const anomalies = stats.filter((s) => s.statType === StatType.Anomaly);

    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    const bigAnomaly = anomalies.find((s) => s.value === 500);
    expect(bigAnomaly).toBeDefined();
    expect(bigAnomaly!.details).toHaveProperty('direction', 'above');
  });

  it('produces category breakdown with percentages', () => {
    const stats = computeStats(fixture.multiCategory);
    const breakdowns = stats.filter(
      (s) => s.statType === StatType.CategoryBreakdown,
    );

    expect(breakdowns.length).toBeGreaterThanOrEqual(2);
    const salesBreakdown = breakdowns.find((s) => s.category === 'Sales');
    expect(salesBreakdown).toBeDefined();
    expect(salesBreakdown!.details).toHaveProperty('percentage');
  });

  it('handles single-row category, total and average only, no trend/anomaly', () => {
    const stats = computeStats(fixture.singleRow);

    const totals = stats.filter((s) => s.statType === StatType.Total);
    expect(totals.length).toBeGreaterThanOrEqual(1);

    const trends = stats.filter((s) => s.statType === StatType.Trend);
    expect(trends).toHaveLength(0);

    const anomalies = stats.filter((s) => s.statType === StatType.Anomaly);
    expect(anomalies).toHaveLength(0);
  });

  it('skips rows with unparseable amounts', () => {
    const stats = computeStats(fixture.withNaN);

    const salesTotal = stats.find(
      (s) =>
        s.statType === StatType.Total &&
        s.category === 'Sales' &&
        s.details.scope === 'category',
    );
    expect(salesTotal?.value).toBe(100);
  });

  it('handles negative amounts correctly', () => {
    const stats = computeStats(fixture.negativeAmounts);

    const total = stats.find(
      (s) =>
        s.statType === StatType.Total &&
        s.category === 'Expenses' &&
        s.details.scope === 'category',
    );
    expect(total?.value).toBe(-650);

    const avg = stats.find(
      (s) =>
        s.statType === StatType.Average &&
        s.category === 'Expenses' &&
        s.details.scope === 'category',
    );
    expect(avg?.value).toBeCloseTo(-216.67, 1);
  });

  it('handles all-same-amount data, no anomalies, flat trend', () => {
    const stats = computeStats(fixture.allSameAmount);

    const anomalies = stats.filter((s) => s.statType === StatType.Anomaly);
    expect(anomalies).toHaveLength(0);

    const trend = stats.find(
      (s) => s.statType === StatType.Trend && s.category === 'Fees',
    );
    if (trend && trend.statType === StatType.Trend) {
      expect(trend.details.slope).toBeCloseTo(0, 5);
    }
  });

  it('never leaks DataRow fields into ComputedStat output', () => {
    const stats = computeStats(fixture.multiCategory);

    for (const stat of stats) {
      const keys = Object.keys(stat);
      expect(keys).not.toContain('orgId');
      expect(keys).not.toContain('datasetId');
      expect(keys).not.toContain('id');
      expect(keys).not.toContain('label');
      expect(keys).not.toContain('metadata');

      const detailKeys = Object.keys(stat.details);
      expect(detailKeys).not.toContain('orgId');
      expect(detailKeys).not.toContain('datasetId');
      expect(detailKeys).not.toContain('rows');
    }
  });

  it('respects trendMinPoints option, suppresses trends below threshold', () => {
    const stats = computeStats(fixture.multiCategory, { trendMinPoints: 5 });
    const trends = stats.filter((s) => s.statType === StatType.Trend);

    // multiCategory has 4 rows per category, below threshold of 5
    expect(trends).toHaveLength(0);
  });

  it('uses absolute values for category breakdown percentages with negative amounts', () => {
    const stats = computeStats(fixture.negativeAmounts);
    const breakdowns = stats.filter(
      (s) => s.statType === StatType.CategoryBreakdown,
    );

    for (const bd of breakdowns) {
      const pct = bd.details.percentage as number;
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

// Trailing burn/surplus stat. Revenue and expense rows are tagged via
// parentCategory, the same contract computeMarginTrend uses.

let _ccfRowId = 1000;

function ccfRow(parentCategory: 'Income' | 'Expenses', year: number, m: number, amount: number) {
  return {
    id: _ccfRowId++,
    orgId: 1,
    datasetId: 1,
    sourceType: 'csv' as const,
    category: parentCategory === 'Income' ? 'Revenue' : 'COGS',
    parentCategory,
    date: new Date(Date.UTC(year, m - 1, 1)),
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

function ccfMonth(year: number, m: number, revenue: number, expenses: number) {
  const rows: ReturnType<typeof ccfRow>[] = [];
  // Skip the Income row when revenue is explicitly 0, that's how the "zero-revenue month"
  // data shape surfaces in production (no income rows for a given bucket).
  if (revenue !== 0) rows.push(ccfRow('Income', year, m, revenue));
  rows.push(ccfRow('Expenses', year, m, expenses));
  return rows;
}

function cashFlowStat(rows: ReturnType<typeof ccfRow>[], opts?: { cashFlowWindow?: number }): CashFlowStat | null {
  const all: ComputedStat[] = computeStats(rows, opts);
  const cf = all.filter((s): s is CashFlowStat => s.statType === StatType.CashFlow);
  if (cf.length === 0) return null;
  if (cf.length > 1) throw new Error(`expected ≤1 CashFlow stat, got ${cf.length}`);
  return cf[0]!;
}

describe('computeCashFlow', () => {
  it('emits burning stat for 3 consecutive loss months, median of sorted nets is the middle element', () => {
    // Distinct nets so median ≠ mean proves median is used.
    // Sorted nets: [-7000, -3000, -1000] → median = -3000, mean ≈ -3666.67
    const rows = [
      ...ccfMonth(2026, 1, 10000, 17000),
      ...ccfMonth(2026, 2, 10000, 13000),
      ...ccfMonth(2026, 3, 10000, 11000),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.direction).toBe('burning');
    expect(stat!.details.monthsBurning).toBe(3);
    expect(stat!.details.trailingMonths).toBe(3);
    expect(stat!.details.monthlyNet).toBe(-3000);
    expect(stat!.value).toBe(-3000);
    expect(stat!.category).toBeNull();
    expect(stat!.details.recentMonths).toHaveLength(3);
  });

  it('emits surplus stat for 3 months of positive nets', () => {
    const rows = [
      ...ccfMonth(2026, 1, 15000, 10000),
      ...ccfMonth(2026, 2, 16000, 11000),
      ...ccfMonth(2026, 3, 17000, 12000),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.direction).toBe('surplus');
    expect(stat!.details.monthsBurning).toBe(0);
    expect(stat!.details.monthlyNet).toBe(5000);
  });

  it('mixed window with median cleanly burning, direction burning, monthsBurning 2', () => {
    // Sorted nets: [-4000, -4000, +500] → median = -4000
    // avg revenue = 10000, threshold = 500, |-4000| = 4000 > 500 → not suppressed
    const rows = [
      ...ccfMonth(2026, 1, 10000, 14000),
      ...ccfMonth(2026, 2, 10000, 14000),
      ...ccfMonth(2026, 3, 10000, 9500),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.direction).toBe('burning');
    expect(stat!.details.monthsBurning).toBe(2);
    expect(stat!.details.monthlyNet).toBe(-4000);
  });

  it('mixed window with median near zero, suppressed (break-even companion fixture)', () => {
    // Sorted nets: [-3000, -100, +4000] → median = -100
    // avg revenue = 10000, threshold = 500, |-100| < 500 → suppressed
    const rows = [
      ...ccfMonth(2026, 1, 10000, 13000),
      ...ccfMonth(2026, 2, 10000, 6000),
      ...ccfMonth(2026, 3, 10000, 10100),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('suppresses when nets are within ±5% of avg revenue', () => {
    // Sorted nets: [-400, -100, +300] → median = -100, |-100| < 500 → suppressed
    const rows = [
      ...ccfMonth(2026, 1, 10000, 10400),
      ...ccfMonth(2026, 2, 10000, 9700),
      ...ccfMonth(2026, 3, 10000, 10100),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('suppresses when any month in the window has revenue === 0 (data gap)', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10000, 5000),
      ...ccfMonth(2026, 2, 0, 5000), // no Income row, revenue bucket defaults to 0
      ...ccfMonth(2026, 3, 10000, 5000),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('suppresses when avgMonthlyRevenue <= 0 but no individual month is zero', () => {
    // Revenues [+100, +100, -200] → mean = 0. None is 0 so zero-revenue guard doesn't trip.
    // avgMonthlyRevenue <= 0 guard fires instead. The March -200 row is a deliberate
    // negative-income fixture (refund/chargeback adjustment), it's the only way to
    // reach the second guard without triggering the first, since Map.get(m) ?? 0
    // makes genuine-zero months look identical to missing-income-row months.
    const rows = [
      ...ccfMonth(2026, 1, 100, 5000),
      ...ccfMonth(2026, 2, 100, 5000),
      ...ccfMonth(2026, 3, -200, 5000),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('service business (expense-only mirror case), emits surplus, not suppressed', () => {
    // Solo consultant: consistent revenue, near-zero expenses.
    // Proves the zero-revenue suppression does NOT mistakenly trigger on zero-expense.
    const rows = [
      ...ccfMonth(2026, 1, 5000, 100),
      ...ccfMonth(2026, 2, 5500, 120),
      ...ccfMonth(2026, 3, 6000, 110),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.direction).toBe('surplus');
    expect(stat!.details.monthsBurning).toBe(0);
    expect(stat!.details.monthlyNet).toBe(5380);
  });

  it('suppresses when the window has fewer than trailingMonths of data', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10000, 14000),
      ...ccfMonth(2026, 2, 10000, 14000),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('window N=3, median is the middle element of sorted nets', () => {
    // Explicit test of median-of-odd-N semantics. Sorted: [-5000, -2000, +1000] → median = -2000
    const rows = [
      ...ccfMonth(2026, 1, 10000, 15000),
      ...ccfMonth(2026, 2, 10000, 12000),
      ...ccfMonth(2026, 3, 10000, 9000),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.monthlyNet).toBe(-2000);
  });

  it('window N=6, median is mean of two middle elements', () => {
    // Sorted nets: [-5000, -4000, -3000, +500, +1000, +1500]
    // median = (sorted[2] + sorted[3]) / 2 = (-3000 + 500) / 2 = -1250
    // Prevents a hand-rolled "middle element" median bug at even window sizes.
    const rows = [
      ...ccfMonth(2026, 1, 10000, 15000),
      ...ccfMonth(2026, 2, 10000, 14000),
      ...ccfMonth(2026, 3, 10000, 13000),
      ...ccfMonth(2026, 4, 10000, 9500),
      ...ccfMonth(2026, 5, 10000, 9000),
      ...ccfMonth(2026, 6, 10000, 8500),
    ];
    const stat = cashFlowStat(rows, { cashFlowWindow: 6 });
    expect(stat).not.toBeNull();
    expect(stat!.details.trailingMonths).toBe(6);
    expect(stat!.details.monthlyNet).toBe(-1250);
    expect(stat!.details.direction).toBe('burning');
    expect(stat!.details.monthsBurning).toBe(3);
    expect(stat!.details.recentMonths).toHaveLength(6);
  });

  it('median robustness, one outlier month does not flip direction', () => {
    // Two small losses + one huge loss. Median shows the typical month,
    // mean would exaggerate. Sorted nets: [-20000, -600, -500] → median = -600, mean ≈ -7033
    const rows = [
      ...ccfMonth(2026, 1, 10000, 10500),
      ...ccfMonth(2026, 2, 10000, 10600),
      ...ccfMonth(2026, 3, 10000, 30000),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    expect(stat!.details.monthlyNet).toBe(-600);
  });

  it('recentMonths carries only aggregated shape, no row-level leaks', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10000, 17000),
      ...ccfMonth(2026, 2, 10000, 13000),
      ...ccfMonth(2026, 3, 10000, 11000),
    ];
    const stat = cashFlowStat(rows);
    expect(stat).not.toBeNull();
    const keys = Object.keys(stat!.details.recentMonths[0]!);
    expect(keys.sort()).toEqual(['expenses', 'month', 'net', 'revenue']);
  });
});

function burningCashFlow(monthlyNet = -5000, monthsBurning = 3): CashFlowStat {
  return {
    statType: StatType.CashFlow,
    category: null,
    value: monthlyNet,
    details: {
      monthlyNet,
      trailingMonths: 3,
      direction: 'burning',
      monthsBurning,
      recentMonths: [
        { month: '2026-02', revenue: 10000, expenses: 15000, net: -5000 },
        { month: '2026-03', revenue: 10000, expenses: 15000, net: -5000 },
        { month: '2026-04', revenue: 10000, expenses: 15000, net: -5000 },
      ],
    },
  };
}

function surplusCashFlow(): CashFlowStat {
  return {
    statType: StatType.CashFlow,
    category: null,
    value: 3000,
    details: {
      monthlyNet: 3000,
      trailingMonths: 3,
      direction: 'surplus',
      monthsBurning: 0,
      recentMonths: [
        { month: '2026-02', revenue: 12000, expenses: 9000, net: 3000 },
        { month: '2026-03', revenue: 12000, expenses: 9000, net: 3000 },
        { month: '2026-04', revenue: 12000, expenses: 9000, net: 3000 },
      ],
    },
  };
}

// Anchor wall-clock date for staleness math, 2026-05-01.
const NOW = new Date('2026-05-01T00:00:00.000Z');

function daysAgoISO(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

describe('runwayConfidence', () => {
  it('high, fresh cash AND sustained burn', () => {
    expect(runwayConfidence(10, 3)).toBe('high');
    expect(runwayConfidence(30, 2)).toBe('high');
  });

  it('moderate, slightly stale OR single-month burn', () => {
    expect(runwayConfidence(45, 3)).toBe('moderate');
    expect(runwayConfidence(30, 1)).toBe('moderate');
  });

  it('low, stale beyond 90 days OR no burn months counted', () => {
    expect(runwayConfidence(100, 3)).toBe('low');
    expect(runwayConfidence(10, 0)).toBe('low');
  });
});

describe('computeRunway', () => {
  it('emits runway stat when burning business has fresh cash balance', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(10) };

    const result = computeRunway(cashFlow, financials, NOW);

    expect(result).toHaveLength(1);
    const stat = result[0]!;
    expect(stat.statType).toBe(StatType.Runway);
    expect(stat.details.runwayMonths).toBe(3.0);
    expect(stat.details.cashOnHand).toBe(15000);
    expect(stat.details.confidence).toBe('high');
  });

  it('rounds runway months to one decimal', () => {
    const cashFlow = [burningCashFlow(-3000, 3)];
    const financials = { cashOnHand: 10000, cashAsOfDate: daysAgoISO(5) };

    const result = computeRunway(cashFlow, financials, NOW);

    expect(result[0]!.details.runwayMonths).toBe(3.3);
  });

  it('suppresses when business is not burning (surplus)', () => {
    const cashFlow = [surplusCashFlow()];
    const financials = { cashOnHand: 50000, cashAsOfDate: daysAgoISO(10) };

    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('suppresses when cash flow array is empty (no signal)', () => {
    const financials = { cashOnHand: 10000, cashAsOfDate: daysAgoISO(10) };
    expect(computeRunway([], financials, NOW)).toEqual([]);
  });

  it('suppresses when cashOnHand is null or undefined', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    expect(computeRunway(cashFlow, null, NOW)).toEqual([]);
    expect(computeRunway(cashFlow, {}, NOW)).toEqual([]);
    expect(computeRunway(cashFlow, { cashAsOfDate: daysAgoISO(1) }, NOW)).toEqual([]);
  });

  it('suppresses when cashOnHand is zero (no runway to report)', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 0, cashAsOfDate: daysAgoISO(5) };
    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('suppresses when cashAsOfDate is missing', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 10000 };
    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('suppresses when cashAsOfDate is malformed', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 10000, cashAsOfDate: 'not-a-date' };
    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('suppresses when cashAsOfDate is older than 180 days (stale)', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(181) };
    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('emits with low confidence at 91-180 day staleness', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(100) };

    const result = computeRunway(cashFlow, financials, NOW);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('low');
  });

  it('critical runway <3 months with high confidence on fresh data', () => {
    const cashFlow = [burningCashFlow(-10000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(5) };

    const result = computeRunway(cashFlow, financials, NOW);

    expect(result[0]!.details.runwayMonths).toBe(1.5);
    expect(result[0]!.details.confidence).toBe('high');
  });

  it('extended runway >=24 months still emitted but ready to be demoted by scoring', () => {
    const cashFlow = [burningCashFlow(-1000, 2)];
    const financials = { cashOnHand: 50000, cashAsOfDate: daysAgoISO(10) };

    const result = computeRunway(cashFlow, financials, NOW);

    expect(result[0]!.details.runwayMonths).toBe(50);
  });

  it('boundary: cashAsOfDate exactly 30 days old stays high confidence', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(30) };

    const result = computeRunway(cashFlow, financials, NOW);
    expect(result[0]!.details.confidence).toBe('high');
  });

  it('boundary: cashAsOfDate 31 days old drops to moderate confidence', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const financials = { cashOnHand: 15000, cashAsOfDate: daysAgoISO(31) };

    const result = computeRunway(cashFlow, financials, NOW);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('suppresses when cashAsOfDate is in the future (clock skew guard)', () => {
    const cashFlow = [burningCashFlow(-5000, 3)];
    const futureDate = new Date(NOW);
    futureDate.setUTCDate(futureDate.getUTCDate() + 5);
    const financials = { cashOnHand: 15000, cashAsOfDate: futureDate.toISOString() };
    expect(computeRunway(cashFlow, financials, NOW)).toEqual([]);
  });

  it('details.monthlyNet stays signed (negative) so assembly can render -$X/mo', () => {
    const cashFlow = [burningCashFlow(-7500, 3)];
    const financials = { cashOnHand: 30000, cashAsOfDate: daysAgoISO(10) };

    const result = computeRunway(cashFlow, financials, NOW);
    expect(result[0]!.details.monthlyNet).toBe(-7500);
  });
});

describe('computeStats wiring for runway', () => {
  it('end-to-end: burning data + cash balance produces runway in ComputedStat[]', () => {
    const rows = [
      ...ccfMonth(2026, 2, 10000, 15000),
      ...ccfMonth(2026, 3, 10000, 15000),
      ...ccfMonth(2026, 4, 10000, 15000),
    ];

    const stats = computeStats(rows, {
      financials: { cashOnHand: 15000, cashAsOfDate: daysAgoISO(10) },
      now: NOW,
    });

    const runway = stats.filter((s): s is RunwayStat => s.statType === StatType.Runway);
    expect(runway).toHaveLength(1);
    expect(runway[0]!.details.runwayMonths).toBe(3.0);
  });

  it('end-to-end: no runway when financials absent', () => {
    const rows = [
      ...ccfMonth(2026, 2, 10000, 15000),
      ...ccfMonth(2026, 3, 10000, 15000),
      ...ccfMonth(2026, 4, 10000, 15000),
    ];

    const stats = computeStats(rows);
    const runway = stats.filter((s) => s.statType === StatType.Runway);
    expect(runway).toEqual([]);
  });
});

function marginStat(
  recentMarginPercent: number,
  direction: 'expanding' | 'shrinking' | 'stable' = 'stable',
): MarginTrendStat {
  return {
    statType: StatType.MarginTrend,
    category: null,
    value: recentMarginPercent,
    comparison: recentMarginPercent,
    details: {
      recentMarginPercent,
      priorMarginPercent: recentMarginPercent,
      direction,
      revenueGrowthPercent: 0,
      expenseGrowthPercent: 0,
    },
  };
}

describe('breakEvenConfidence', () => {
  it('high when margin >= 10 and direction is not shrinking', () => {
    expect(breakEvenConfidence(25, 'expanding')).toBe('high');
    expect(breakEvenConfidence(15, 'stable')).toBe('high');
    expect(breakEvenConfidence(10, 'stable')).toBe('high');
    expect(breakEvenConfidence(10, 'expanding')).toBe('high');
  });

  it('moderate when margin >= 10 but direction is shrinking', () => {
    expect(breakEvenConfidence(20, 'shrinking')).toBe('moderate');
    expect(breakEvenConfidence(10, 'shrinking')).toBe('moderate');
  });

  it('moderate for margin in [5, 10) regardless of direction', () => {
    expect(breakEvenConfidence(7, 'expanding')).toBe('moderate');
    expect(breakEvenConfidence(5, 'shrinking')).toBe('moderate');
    expect(breakEvenConfidence(9.9, 'stable')).toBe('moderate');
  });

  it('low for margin below 5', () => {
    expect(breakEvenConfidence(4.9, 'stable')).toBe('low');
    expect(breakEvenConfidence(3, 'expanding')).toBe('low');
    expect(breakEvenConfidence(2, 'shrinking')).toBe('low');
  });
});

describe('computeBreakEven', () => {
  it('healthy business above break-even: gap is negative, confidence high, demoted elsewhere', () => {
    // margin 25%, fixed 10k, revenue 80k → break-even 40k → gap = 40k - 80k = -40k
    const result = computeBreakEven([marginStat(25, 'expanding')], 10_000, 80_000);

    expect(result).toHaveLength(1);
    const stat = result[0]!;
    expect(stat.statType).toBe(StatType.BreakEven);
    expect(stat.details.breakEvenRevenue).toBe(40_000);
    expect(stat.details.gap).toBe(-40_000);
    expect(stat.details.confidence).toBe('high');
    expect(stat.details.marginPercent).toBe(25);
    expect(stat.details.monthlyFixedCosts).toBe(10_000);
    expect(stat.details.currentMonthlyRevenue).toBe(80_000);
    expect(stat.value).toBe(40_000);
    expect(stat.category).toBeNull();
  });

  it('burning business below break-even: gap is positive, high confidence, high actionability', () => {
    // margin 20%, fixed 15k, revenue 50k → break-even 75k → gap = 75k - 50k = 25k
    const result = computeBreakEven([marginStat(20, 'stable')], 15_000, 50_000);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.breakEvenRevenue).toBe(75_000);
    expect(result[0]!.details.gap).toBe(25_000);
    expect(result[0]!.details.confidence).toBe('high');
  });

  it('shrinking margin at >=10% demotes confidence to moderate (direction override)', () => {
    const result = computeBreakEven([marginStat(15, 'shrinking')], 10_000, 50_000);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('low margin (5-9.9%) lands at moderate confidence', () => {
    const result = computeBreakEven([marginStat(7, 'stable')], 10_000, 50_000);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('thin margin (2-4.9%) lands at low confidence', () => {
    const result = computeBreakEven([marginStat(3, 'stable')], 10_000, 50_000);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('low');
  });

  it('suppresses when margin stats are empty (no margin signal)', () => {
    expect(computeBreakEven([], 10_000, 50_000)).toEqual([]);
  });

  it('suppresses when monthlyFixedCosts is undefined', () => {
    expect(computeBreakEven([marginStat(25)], undefined, 50_000)).toEqual([]);
  });

  it('suppresses when monthlyFixedCosts is null', () => {
    expect(computeBreakEven([marginStat(25)], null, 50_000)).toEqual([]);
  });

  it('suppresses when monthlyFixedCosts is zero', () => {
    expect(computeBreakEven([marginStat(25)], 0, 50_000)).toEqual([]);
  });

  it('suppresses when margin is zero (infinite break-even)', () => {
    expect(computeBreakEven([marginStat(0)], 10_000, 50_000)).toEqual([]);
  });

  it('suppresses when margin is negative (negative break-even is nonsense)', () => {
    expect(computeBreakEven([marginStat(-5)], 10_000, 50_000)).toEqual([]);
  });

  it('suppresses when margin is trivially low (<2%)', () => {
    expect(computeBreakEven([marginStat(1.5)], 10_000, 50_000)).toEqual([]);
    expect(computeBreakEven([marginStat(1.99)], 10_000, 50_000)).toEqual([]);
  });

  it('suppresses when currentMonthlyRevenue is NaN (upstream aggregation guard)', () => {
    expect(computeBreakEven([marginStat(25)], 10_000, Number.NaN)).toEqual([]);
  });

  it('zero currentMonthlyRevenue emits with gap === breakEvenRevenue (pre-revenue case)', () => {
    const result = computeBreakEven([marginStat(20)], 10_000, 0);

    expect(result).toHaveLength(1);
    expect(result[0]!.details.breakEvenRevenue).toBe(50_000);
    expect(result[0]!.details.gap).toBe(50_000);
    expect(result[0]!.details.currentMonthlyRevenue).toBe(0);
  });

  it('boundary: margin exactly 10% + expanding direction → high confidence', () => {
    const result = computeBreakEven([marginStat(10, 'expanding')], 10_000, 50_000);
    expect(result[0]!.details.confidence).toBe('high');
  });

  it('boundary: margin exactly 10% + shrinking direction → moderate confidence', () => {
    const result = computeBreakEven([marginStat(10, 'shrinking')], 10_000, 50_000);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('boundary: margin exactly 5% → moderate confidence', () => {
    const result = computeBreakEven([marginStat(5, 'expanding')], 10_000, 50_000);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('boundary: margin 4.9% → low confidence', () => {
    const result = computeBreakEven([marginStat(4.9, 'expanding')], 10_000, 50_000);
    expect(result[0]!.details.confidence).toBe('low');
  });

  it('boundary: margin exactly 2% → emits with low confidence', () => {
    const result = computeBreakEven([marginStat(2, 'stable')], 10_000, 50_000);
    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('low');
  });

  it('break-even details carry only numbers and confidence enum, no row-level leak', () => {
    const result = computeBreakEven([marginStat(25)], 10_000, 50_000);
    const keys = Object.keys(result[0]!.details).sort();
    expect(keys).toEqual(['breakEvenRevenue', 'confidence', 'currentMonthlyRevenue', 'gap', 'marginPercent', 'monthlyFixedCosts']);
  });
});

describe('computeStats wiring for break-even', () => {
  it('end-to-end: margin signal + monthly fixed costs produces BreakEven in ComputedStat[]', () => {
    // 6 months of data producing margin ~20%, revenue 10k/mo, expenses 8k/mo
    const rows = [
      ...ccfMonth(2026, 1, 10000, 8000),
      ...ccfMonth(2026, 2, 10000, 8000),
      ...ccfMonth(2026, 3, 10000, 8000),
      ...ccfMonth(2026, 4, 10000, 8000),
      ...ccfMonth(2026, 5, 10000, 8000),
      ...ccfMonth(2026, 6, 10000, 8000),
    ];

    const stats = computeStats(rows, {
      financials: { monthlyFixedCosts: 5_000 },
    });

    const breakEven = stats.filter((s): s is BreakEvenStat => s.statType === StatType.BreakEven);
    expect(breakEven).toHaveLength(1);
    // margin = (10k - 8k) / 10k = 20%, break-even = 5k / 0.20 = 25k
    expect(breakEven[0]!.details.breakEvenRevenue).toBe(25_000);
    expect(breakEven[0]!.details.currentMonthlyRevenue).toBe(10_000);
    expect(breakEven[0]!.details.gap).toBe(15_000);
  });

  it('end-to-end: no break-even when monthlyFixedCosts absent', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10000, 8000),
      ...ccfMonth(2026, 2, 10000, 8000),
      ...ccfMonth(2026, 3, 10000, 8000),
      ...ccfMonth(2026, 4, 10000, 8000),
    ];

    const stats = computeStats(rows);
    const breakEven = stats.filter((s) => s.statType === StatType.BreakEven);
    expect(breakEven).toEqual([]);
  });

  it('end-to-end: no break-even when margin trend suppressed (fewer than 4 months)', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10000, 8000),
      ...ccfMonth(2026, 2, 10000, 8000),
      ...ccfMonth(2026, 3, 10000, 8000),
    ];

    const stats = computeStats(rows, { financials: { monthlyFixedCosts: 5_000 } });
    const breakEven = stats.filter((s) => s.statType === StatType.BreakEven);
    expect(breakEven).toEqual([]);
  });
});

// `burningCashFlow` is already defined above in the Runway test fixtures, reuse it.
// The forecast public signature takes CashFlowStat + monthlyNetsWindow output, so
// the existing helper stands in cleanly.

function netsWindow(months: number, nets: number[]): { months: string[]; nets: number[] } {
  const monthKeys: string[] = [];
  for (let i = 0; i < months; i++) {
    const m = (i % 12) + 1;
    const y = 2026 + Math.floor(i / 12);
    monthKeys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return { months: monthKeys, nets };
}

describe('computeCashForecast', () => {
  const NOW = new Date('2026-06-15T00:00:00Z');
  const freshCashDate = '2026-06-01T00:00:00Z';

  it('consistent burn: emits a 3-month declining trajectory with crossesZeroAtMonth set', () => {
    const nets = [-10000, -10000, -10000, -10000, -10000, -10000];
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 25_000, cashAsOfDate: freshCashDate },
      netsWindow(6, nets),
      NOW,
    );

    expect(result).toHaveLength(1);
    const d = result[0]!.details;
    expect(d.method).toBe('linear_regression');
    expect(d.startingBalance).toBe(25_000);
    expect(d.projectedMonths).toHaveLength(3);
    expect(d.projectedMonths[0]!.projectedBalance).toBe(15_000);
    expect(d.projectedMonths[1]!.projectedBalance).toBe(5_000);
    expect(d.projectedMonths[2]!.projectedBalance).toBe(-5_000);
    expect(d.crossesZeroAtMonth).toBe(3);
    expect(d.confidence).toBe('high');
  });

  it('accelerating burn: regression catches the trend, earlier zero crossing than flat extrapolation', () => {
    const nets = [-5000, -7000, -9000, -11000, -13000, -15000];
    const result = computeCashForecast(
      [burningCashFlow(-10000, 6)],
      { cashOnHand: 50_000, cashAsOfDate: freshCashDate },
      netsWindow(6, nets),
      NOW,
    );

    expect(result).toHaveLength(1);
    const d = result[0]!.details;
    expect(d.method).toBe('linear_regression');
    // Regression slope ≈ -2000; forecast nets at t=6,7,8 ≈ -17k, -19k, -21k
    // Running balance 50k → 33k → 14k → -7k
    expect(d.projectedMonths[0]!.projectedBalance).toBeLessThan(40_000);
    expect(d.projectedMonths[2]!.projectedBalance).toBeLessThan(0);
    expect(d.crossesZeroAtMonth).toBeLessThanOrEqual(3);
  });

  it('decelerating burn: slope reverses, zero crossing further out or absent', () => {
    const nets = [-15000, -13000, -11000, -9000, -7000, -5000];
    const result = computeCashForecast(
      [burningCashFlow(-10000, 6)],
      { cashOnHand: 50_000, cashAsOfDate: freshCashDate },
      netsWindow(6, nets),
      NOW,
    );

    expect(result).toHaveLength(1);
    const d = result[0]!.details;
    // slope ≈ +2000 (improving), intercept ≈ -17k
    // forecast at t=6,7,8 ≈ -5k, -3k, -1k, balance stays above zero
    expect(d.crossesZeroAtMonth).toBeNull();
  });

  it('surplus trajectory: crossesZeroAtMonth is null, balance holds positive', () => {
    const nets = [3000, 4000, 5000, 4000, 5000, 6000];
    const result = computeCashForecast(
      [burningCashFlow()], // burning upstream signal just gates emission; projection uses nets
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      netsWindow(6, nets),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.details.crossesZeroAtMonth).toBeNull();
  });

  it('degenerate regression (all nets identical across 3 months) falls back to rolling_mean with low confidence', () => {
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 20_000, cashAsOfDate: freshCashDate },
      netsWindow(3, [-5000, -5000, -5000]),
      NOW,
    );

    expect(result).toHaveLength(1);
    const d = result[0]!.details;
    // 3 identical points yield a valid zero-slope regression; method stays linear_regression.
    // But 3 < 6 months → confidence is 'low' anyway.
    expect(d.confidence).toBe('low');
    expect(d.slope).toBe(0);
  });

  it('volatile nets demote confidence from high to moderate even with 6+ months + fresh cash', () => {
    // 5 smooth months + 1 outlier 3σ away
    const nets = [-5000, -5500, -5000, -5500, -5000, -50000];
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 40_000, cashAsOfDate: freshCashDate },
      netsWindow(6, nets),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('thin data (3 basis months) lands at low confidence', () => {
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      netsWindow(3, [-5000, -5500, -6000]),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('low');
  });

  it('stale cash (>30 and <=90 days old) demotes confidence to moderate', () => {
    // cashAsOfDate is 45 days before NOW
    const staleCashDate = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 40_000, cashAsOfDate: staleCashDate },
      netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
      NOW,
    );

    expect(result).toHaveLength(1);
    // 45 days > 30 → fails the 'high' predicate → falls to the default 'moderate'
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('very stale cash (>90 days) explicitly downgrades to moderate via the stale-cash rule', () => {
    const staleCashDate = new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 40_000, cashAsOfDate: staleCashDate },
      netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.details.confidence).toBe('moderate');
  });

  it('suppresses when CashFlow is suppressed (empty cashFlowStats)', () => {
    expect(
      computeCashForecast(
        [],
        { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
        netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('suppresses when cashOnHand is null', () => {
    expect(
      computeCashForecast(
        [burningCashFlow()],
        { cashOnHand: undefined, cashAsOfDate: freshCashDate },
        netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('suppresses when cashOnHand is zero', () => {
    expect(
      computeCashForecast(
        [burningCashFlow()],
        { cashOnHand: 0, cashAsOfDate: freshCashDate },
        netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('suppresses when cashAsOfDate is more than 180 days old', () => {
    const veryStaleCashDate = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeCashForecast(
        [burningCashFlow()],
        { cashOnHand: 30_000, cashAsOfDate: veryStaleCashDate },
        netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('suppresses when cashAsOfDate is in the future (clock skew)', () => {
    const futureCashDate = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      computeCashForecast(
        [burningCashFlow()],
        { cashOnHand: 30_000, cashAsOfDate: futureCashDate },
        netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('suppresses when fewer than 3 basis months', () => {
    expect(
      computeCashForecast(
        [burningCashFlow()],
        { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
        netsWindow(2, [-5000, -5000]),
        NOW,
      ),
    ).toEqual([]);
  });

  it('month rollover: basis ending in Nov 2026 projects Dec 2026, Jan 2027, Feb 2027', () => {
    const months = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'];
    const nets = [-5000, -5000, -5000, -5000, -5000, -5000];
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      { months, nets },
      NOW,
    );

    expect(result).toHaveLength(1);
    const projectedMonthKeys = result[0]!.details.projectedMonths.map((pm) => pm.month);
    expect(projectedMonthKeys).toEqual(['2026-12', '2027-01', '2027-02']);
  });

  it('year rollover at December basis ends: Dec 2026 → Jan 2027, Feb 2027, Mar 2027', () => {
    const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12'];
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      { months, nets: [-5000, -5000, -5000, -5000, -5000, -5000] },
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.details.projectedMonths.map((pm) => pm.month)).toEqual([
      '2027-01',
      '2027-02',
      '2027-03',
    ]);
  });

  it('non-contiguous basis months still produce a valid forecast (gap months treated as even steps)', () => {
    // Business with a zero-revenue gap in March, monthlyNetsWindow drops it.
    // Regression treats the remaining 5 months as evenly spaced. Documents the
    // limitation: the slope reflects the trend over observed months, projected
    // forward as if the next three are also non-gap.
    const months = ['2026-01', '2026-02', '2026-04', '2026-05', '2026-06'];
    const nets = [-5000, -5500, -6000, -6500, -7000];
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      { months, nets },
      NOW,
    );

    expect(result).toHaveLength(1);
    const d = result[0]!.details;
    expect(d.projectedMonths).toHaveLength(3);
    expect(d.projectedMonths[0]!.month).toBe('2026-07'); // next calendar month after last basis
    // Inputs -5000, -5500, -6000, -6500, -7000 at indices 0..4 fit exactly to
    // slope=-500, intercept=-5000 under least-squares. Asserting the precise
    // value pins the "gap months treated as even steps" contract, if
    // monthlyNetsWindow's gap-drop behavior ever changes, this test fails.
    expect(d.slope).toBeCloseTo(-500, 0);
    expect(d.intercept).toBeCloseTo(-5000, 0);
  });

  it('forecast details shape carries only scalars, ISO strings, month keys, and enum, no row leak', () => {
    const result = computeCashForecast(
      [burningCashFlow()],
      { cashOnHand: 30_000, cashAsOfDate: freshCashDate },
      netsWindow(6, [-5000, -5000, -5000, -5000, -5000, -5000]),
      NOW,
    );

    expect(result).toHaveLength(1);
    const keys = Object.keys(result[0]!.details).sort();
    expect(keys).toEqual([
      'asOfDate',
      'basisMonths',
      'basisValues',
      'confidence',
      'crossesZeroAtMonth',
      'intercept',
      'method',
      'projectedMonths',
      'slope',
      'startingBalance',
    ]);
  });
});

// Local-time mid-month row. monthKey now reads UTC accessors, so this no
// longer needs to dodge a timezone boundary, day 15 local time is safely
// mid-month under UTC too. Kept as local-time construction anyway: it's the
// simplest way to build a row whose calendar month is unambiguous regardless
// of which accessor reads it.
let _midRowId = 50_000;
function midMonthRow(parentCategory: 'Income' | 'Expenses', year: number, m: number, amount: number) {
  return {
    id: _midRowId++,
    orgId: 1,
    datasetId: 1,
    sourceType: 'csv' as const,
    category: parentCategory === 'Income' ? 'Revenue' : 'COGS',
    parentCategory,
    date: new Date(year, m - 1, 15, 12),
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}
function midMonth(year: number, m: number, revenue: number, expenses: number) {
  const rows = [];
  if (revenue !== 0) rows.push(midMonthRow('Income', year, m, revenue));
  rows.push(midMonthRow('Expenses', year, m, expenses));
  return rows;
}

function buckets(entries: Array<[string, { revenue: number; expenses: number }]>): MonthlyBucketMap {
  return new Map(entries);
}

describe('bucketRowsByMonth', () => {
  it('aggregates income + expenses per UTC calendar month', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 6_000),
      ...midMonth(2026, 1, 5_000, 1_000), // same month, sums
      ...midMonth(2026, 2, 8_000, 4_000),
    ];
    const map = bucketRowsByMonth(rows);
    expect(map.get('2026-01')).toEqual({ revenue: 15_000, expenses: 7_000 });
    expect(map.get('2026-02')).toEqual({ revenue: 8_000, expenses: 4_000 });
  });

  it('ignores rows with non-finite amounts', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 6_000),
      { ...midMonth(2026, 1, 0, 0)[0]!, amount: 'not-a-number' },
    ];
    const map = bucketRowsByMonth(rows);
    expect(map.get('2026-01')?.revenue).toBe(10_000);
  });
});

describe('cashFlowFromBuckets', () => {
  it('emits burning stat for three consecutive loss months from pre-aggregated buckets', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 15_000 }],
      ['2026-02', { revenue: 10_000, expenses: 14_000 }],
      ['2026-03', { revenue: 10_000, expenses: 16_000 }],
    ]);
    const result = cashFlowFromBuckets(map, 3);
    expect(result).toHaveLength(1);
    expect(result[0]!.details.direction).toBe('burning');
  });

  it('suppresses when a recent month has zero revenue (gap)', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 15_000 }],
      ['2026-02', { revenue: 0, expenses: 14_000 }], // gap
      ['2026-03', { revenue: 10_000, expenses: 16_000 }],
    ]);
    expect(cashFlowFromBuckets(map, 3)).toEqual([]);
  });

  it('suppresses when net is within the 5% break-even band', () => {
    // avg revenue 10k, 5% band = 500. Net of 200 should suppress.
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 9_800 }], // net +200
      ['2026-02', { revenue: 10_000, expenses: 9_800 }],
      ['2026-03', { revenue: 10_000, expenses: 9_800 }],
    ]);
    expect(cashFlowFromBuckets(map, 3)).toEqual([]);
  });

  it('produces identical output as computeCashFlow(rows) for equivalent data', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 15_000),
      ...midMonth(2026, 2, 10_000, 14_000),
      ...midMonth(2026, 3, 10_000, 16_000),
    ];
    const fromRows = cashFlowFromBuckets(bucketRowsByMonth(rows), 3);
    const fromBuckets = cashFlowFromBuckets(
      buckets([
        ['2026-01', { revenue: 10_000, expenses: 15_000 }],
        ['2026-02', { revenue: 10_000, expenses: 14_000 }],
        ['2026-03', { revenue: 10_000, expenses: 16_000 }],
      ]),
      3,
    );
    expect(fromRows[0]!.details.monthlyNet).toBe(fromBuckets[0]!.details.monthlyNet);
    expect(fromRows[0]!.details.monthsBurning).toBe(fromBuckets[0]!.details.monthsBurning);
  });
});

describe('cashFlowForAlerting', () => {
  it('returns a real stat inside the 5% break-even band where cashFlowFromBuckets suppresses (DW-7)', () => {
    // Same fixture as the cashFlowFromBuckets band-suppression test above:
    // avg revenue 10k, 5% band = 500, net of 200 is inside it.
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 9_800 }], // net +200
      ['2026-02', { revenue: 10_000, expenses: 9_800 }],
      ['2026-03', { revenue: 10_000, expenses: 9_800 }],
    ]);

    expect(cashFlowFromBuckets(map, 3)).toEqual([]);

    const result = cashFlowForAlerting(map, 3);
    expect(result).toHaveLength(1);
    expect(result[0]!.details.monthlyNet).toBe(200);
    expect(result[0]!.details.direction).toBe('surplus');
  });

  it('still suppresses when a recent month has zero revenue (gap)', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 15_000 }],
      ['2026-02', { revenue: 0, expenses: 14_000 }], // gap
      ['2026-03', { revenue: 10_000, expenses: 16_000 }],
    ]);
    expect(cashFlowForAlerting(map, 3)).toEqual([]);
  });

  it('still suppresses when average revenue is non-positive', () => {
    const map = buckets([
      ['2026-01', { revenue: -1_000, expenses: 5_000 }],
      ['2026-02', { revenue: -500, expenses: 4_000 }],
      ['2026-03', { revenue: -800, expenses: 6_000 }],
    ]);
    expect(cashFlowForAlerting(map, 3)).toEqual([]);
  });

  it('still suppresses when fewer than trailingMonths buckets exist', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 9_800 }],
      ['2026-02', { revenue: 10_000, expenses: 9_800 }],
    ]);
    expect(cashFlowForAlerting(map, 3)).toEqual([]);
  });
});

describe('netsFromBuckets', () => {
  it('drops zero-revenue months and returns the trailing window', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 6_000 }],
      ['2026-02', { revenue: 0, expenses: 5_000 }], // gap, dropped
      ['2026-03', { revenue: 10_000, expenses: 7_000 }],
      ['2026-04', { revenue: 10_000, expenses: 8_000 }],
    ]);
    const { months, nets } = netsFromBuckets(map, 12);
    expect(months).toEqual(['2026-01', '2026-03', '2026-04']);
    expect(nets).toEqual([4_000, 3_000, 2_000]);
  });

  it('respects the windowSize limit against the non-gap months', () => {
    const map = buckets([
      ['2026-01', { revenue: 10_000, expenses: 6_000 }],
      ['2026-02', { revenue: 10_000, expenses: 7_000 }],
      ['2026-03', { revenue: 10_000, expenses: 8_000 }],
      ['2026-04', { revenue: 10_000, expenses: 9_000 }],
    ]);
    const { months } = netsFromBuckets(map, 2);
    expect(months).toEqual(['2026-03', '2026-04']);
  });
});

describe('monthlyNetsWindow', () => {
  it('aggregates income − expenses per YYYY-MM month', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 6_000),
      ...midMonth(2026, 2, 10_000, 7_000),
      ...midMonth(2026, 3, 10_000, 8_000),
    ];

    const { months, nets } = monthlyNetsWindow(rows, 12);
    expect(months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(nets).toEqual([4_000, 3_000, 2_000]);
  });

  it('drops zero-revenue months (gap handling matches computeCashFlow)', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 6_000),
      ...midMonth(2026, 2, 0, 5_000), // gap month, no income row
      ...midMonth(2026, 3, 10_000, 7_000),
    ];

    const { months } = monthlyNetsWindow(rows, 12);
    expect(months).toEqual(['2026-01', '2026-03']);
  });

  it('respects the trailing windowSize limit', () => {
    const rows = [
      ...midMonth(2026, 1, 10_000, 6_000),
      ...midMonth(2026, 2, 10_000, 7_000),
      ...midMonth(2026, 3, 10_000, 8_000),
      ...midMonth(2026, 4, 10_000, 9_000),
    ];

    const { months } = monthlyNetsWindow(rows, 2);
    expect(months).toEqual(['2026-03', '2026-04']);
  });
});

describe('computeStats wiring for cash forecast', () => {
  it('end-to-end: burning cashflow + fresh cashOnHand emits CashForecast in the pipeline output', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10_000, 15_000),
      ...ccfMonth(2026, 2, 10_000, 15_000),
      ...ccfMonth(2026, 3, 10_000, 15_000),
      ...ccfMonth(2026, 4, 10_000, 15_000),
      ...ccfMonth(2026, 5, 10_000, 15_000),
      ...ccfMonth(2026, 6, 10_000, 15_000),
    ];

    const stats = computeStats(rows, {
      financials: { cashOnHand: 20_000, cashAsOfDate: '2026-06-01T00:00:00Z' },
      now: new Date('2026-06-15T00:00:00Z'),
    });

    const forecast = stats.filter((s): s is CashForecastStat => s.statType === StatType.CashForecast);
    expect(forecast).toHaveLength(1);
    expect(forecast[0]!.details.projectedMonths).toHaveLength(3);
    expect(forecast[0]!.details.method).toBe('linear_regression');
  });

  it('end-to-end: no forecast when cashOnHand absent', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10_000, 15_000),
      ...ccfMonth(2026, 2, 10_000, 15_000),
      ...ccfMonth(2026, 3, 10_000, 15_000),
      ...ccfMonth(2026, 4, 10_000, 15_000),
      ...ccfMonth(2026, 5, 10_000, 15_000),
      ...ccfMonth(2026, 6, 10_000, 15_000),
    ];

    const stats = computeStats(rows);
    expect(stats.filter((s) => s.statType === StatType.CashForecast)).toEqual([]);
  });

  it('end-to-end: no forecast when fewer than 3 basis months', () => {
    const rows = [
      ...ccfMonth(2026, 1, 10_000, 15_000),
      ...ccfMonth(2026, 2, 10_000, 15_000),
    ];

    const stats = computeStats(rows, {
      financials: { cashOnHand: 20_000, cashAsOfDate: '2026-02-15T00:00:00Z' },
      now: new Date('2026-02-28T00:00:00Z'),
    });

    expect(stats.filter((s) => s.statType === StatType.CashForecast)).toEqual([]);
  });
});

describe('resolveStatById', () => {
  it('finds a stat by its instance id', () => {
    const stats = computeStats(fixture.multiCategory);
    const target = assignIds(stats, 1).find(
      (s) => s.statType === StatType.Total && s.category === 'Sales' && s.details.scope === 'category',
    )!;

    const resolved = resolveStatById(fixture.multiCategory, 1, target.id);

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(target.id);
    expect(resolved!.value).toBe(7000);
  });

  it('returns null for an id that was never computed', () => {
    expect(resolveStatById(fixture.multiCategory, 1, '1:total:Nonexistent:category')).toBeNull();
  });

  it('an id minted for a different datasetId never matches, only the recomputed set decides', () => {
    const stats = computeStats(fixture.multiCategory);
    const idForOtherDataset = assignIds(stats, 2).find(
      (s) => s.statType === StatType.Total && s.category === 'Sales' && s.details.scope === 'category',
    )!.id;

    expect(resolveStatById(fixture.multiCategory, 1, idForOtherDataset)).toBeNull();
  });
});

describe('resolveStatByType', () => {
  it('finds a stat by statType and category, matching the id assignIds would produce', () => {
    const expected = assignIds(computeStats(fixture.multiCategory), 1).find(
      (s) => s.statType === StatType.Total && s.category === 'Sales' && s.details.scope === 'category',
    )!;

    const resolved = resolveStatByType(fixture.multiCategory, 1, StatType.Total, 'Sales');

    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(expected.id);
    expect(resolved!.value).toBe(7000);
  });

  it('matches on statType alone when category is omitted, for org-wide stats like cash flow', () => {
    const rows = [
      ...ccfMonth(2026, 1, 8000, 9000),
      ...ccfMonth(2026, 2, 8000, 9000),
      ...ccfMonth(2026, 3, 8000, 9000),
    ];
    const expected = assignIds(computeStats(rows), 1).find((s) => s.statType === StatType.CashFlow)!;

    expect(resolveStatByType(rows, 1, StatType.CashFlow)!.id).toBe(expected.id);
  });

  it('returns null when no stat matches the requested statType and category', () => {
    expect(resolveStatByType(fixture.multiCategory, 1, StatType.MarginTrend, 'Sales')).toBeNull();
  });

  it('picks the most recent month when computeYearOverYear emits more than one stat for the same category', () => {
    // Day 15 (not day 1, like ccfRow uses) so local-timezone reads of these
    // dates can't roll a month over into the neighboring one at UTC offsets
    // west of UTC. Jan and Mar 2026 both clear the 3% significance threshold
    // vs. 2025; Feb doesn't. computeYearOverYear pushes Jan before Mar
    // (row/month insertion order), so picking "the first match" would
    // silently return the stale January comparison.
    function revenueRow(year: number, month: number, amount: number) {
      return {
        id: _ccfRowId++,
        orgId: 1,
        datasetId: 1,
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
    const rows = [
      revenueRow(2025, 1, 1000),
      revenueRow(2025, 2, 1000),
      revenueRow(2025, 3, 1000),
      revenueRow(2026, 1, 1200),
      revenueRow(2026, 2, 1000),
      revenueRow(2026, 3, 1500),
    ];

    const yoyStats = assignIds(computeStats(rows), 1).filter((s) => s.statType === StatType.YearOverYear);
    expect(yoyStats).toHaveLength(2); // proves the fixture actually produces the ambiguity under test

    const resolved = resolveStatByType(rows, 1, StatType.YearOverYear, 'Revenue');
    expect(resolved!.value).toBe(1500);
  });
});

describe('monthKey', () => {
  it('formats a date as YYYY-MM with a zero-padded month', () => {
    expect(monthKey(new Date(2026, 0, 15))).toBe('2026-01');
    expect(monthKey(new Date(2026, 10, 3))).toBe('2026-11');
  });
});

describe('marginTrendMonths', () => {
  function monthRow(parentCategory: 'Income' | 'Expenses', year: number, month: number, amount: string) {
    return {
      id: 1,
      orgId: 1,
      datasetId: 1,
      sourceType: 'csv' as const,
      category: parentCategory,
      parentCategory,
      date: new Date(year, month, 15),
      amount,
      label: null,
      metadata: null,
      createdAt: new Date(),
    };
  }

  it('splits six Income/Expenses months into a 3/3 recent/prior window', () => {
    const rows = [0, 1, 2, 3, 4, 5].flatMap((m) => [
      monthRow('Income', 2026, m, '1000.00'),
      monthRow('Expenses', 2026, m, '600.00'),
    ]);

    expect(marginTrendMonths(rows)).toEqual({
      recentMonths: ['2026-04', '2026-05', '2026-06'],
      priorMonths: ['2026-01', '2026-02', '2026-03'],
    });
  });

  it('returns null with fewer than 4 distinct Income/Expenses months', () => {
    const rows = [0, 1, 2].map((m) => monthRow('Income', 2026, m, '1000.00'));
    expect(marginTrendMonths(rows)).toBeNull();
  });

  it('ignores rows outside Income/Expenses when counting distinct months', () => {
    const rows = [
      ...[0, 1, 2].map((m) => monthRow('Income', 2026, m, '1000.00')),
      { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'OfficeSupplies', parentCategory: null, date: new Date(2026, 3, 15), amount: '50.00', label: null, metadata: null, createdAt: new Date() },
    ];
    expect(marginTrendMonths(rows)).toBeNull();
  });

  it('returns null for empty rows', () => {
    expect(marginTrendMonths([])).toBeNull();
  });
});

// DW-51/52 regression: dataRows.date arrives from Drizzle/postgres-js as a
// UTC-midnight instant. Reading it with local-time accessors under a TZ west
// of UTC rolls day-1-of-month rows into the prior month. process.env.TZ is
// stubbed per-test (Node re-reads it on every local Date call) rather than
// for the whole file, so every other test in here stays proof the surrounding
// functions are timezone-independent by construction.
describe('UTC month-boundary regression (DW-51/52)', () => {
  function stubTz(tz: string): () => void {
    const original = process.env.TZ;
    process.env.TZ = tz;
    return () => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    };
  }

  it('monthKey attributes a UTC-midnight day-1 row to the UTC month, not the local one', () => {
    const restore = stubTz('America/New_York');
    try {
      expect(monthKey(new Date(Date.UTC(2026, 1, 1)))).toBe('2026-02');
    } finally {
      restore();
    }
  });

  it('computeYearOverYear (via computeStats) attributes UTC-midnight day-1 rows to the UTC month', () => {
    const restore = stubTz('America/New_York');
    try {
      function boundaryRevenueRow(year: number, month: number, amount: number) {
        return {
          id: _ccfRowId++,
          orgId: 1,
          datasetId: 1,
          sourceType: 'csv' as const,
          category: 'Revenue',
          parentCategory: 'Income' as const,
          date: new Date(Date.UTC(year, month - 1, 1)),
          amount: amount.toFixed(2),
          label: null,
          metadata: null,
          createdAt: new Date(),
        };
      }
      // Both rows land on Feb 1st UTC midnight. In America/New_York (UTC-5),
      // local accessors would read this as Jan 31st, misattributing both
      // years to January and reporting the wrong comparison month.
      const rows = [boundaryRevenueRow(2025, 2, 1000), boundaryRevenueRow(2026, 2, 1500)];

      const yoyStats = computeStats(rows).filter(
        (s): s is YearOverYearStat => s.statType === StatType.YearOverYear,
      );

      expect(yoyStats).toHaveLength(1);
      expect(yoyStats[0]!.details.month).toBe('Feb');
      expect(yoyStats[0]!.details.currentYearLabel).toBe('2026');
      expect(yoyStats[0]!.details.priorYearLabel).toBe('2025');
      expect(yoyStats[0]!.value).toBe(1500);
    } finally {
      restore();
    }
  });

  it('computeSeasonalProjection (via computeStats) anchors a UTC-midnight day-1 basis row to the UTC month', () => {
    const restore = stubTz('America/New_York');
    try {
      function revenueRow(amount: number, date: Date) {
        return {
          id: _ccfRowId++,
          orgId: 1,
          datasetId: 1,
          sourceType: 'csv' as const,
          category: 'Revenue',
          parentCategory: 'Income' as const,
          date,
          amount: amount.toFixed(2),
          label: null,
          metadata: null,
          createdAt: new Date(),
        };
      }
      const rows = [
        // Safe, local-time mid-month row: establishes 2026's latest month as
        // January, so the projection target is February.
        revenueRow(1200, new Date(2026, 0, 15)),
        // The row under test: Feb 1st 2025 UTC midnight. If read with local
        // accessors under America/New_York, this rolls back into January
        // 2025 and drops out of the February basis entirely.
        revenueRow(900, new Date(Date.UTC(2025, 1, 1))),
      ];

      const seasonalStats = computeStats(rows).filter(
        (s): s is SeasonalProjectionStat => s.statType === StatType.SeasonalProjection,
      );

      expect(seasonalStats).toHaveLength(1);
      expect(seasonalStats[0]!.details.projectedMonth).toBe('Feb 2026');
      expect(seasonalStats[0]!.details.basisMonths).toEqual(['Feb 2025']);
      expect(seasonalStats[0]!.details.basisValues).toEqual([900]);
    } finally {
      restore();
    }
  });

  it('monthKey stays UTC-anchored east of UTC too, for any UTC instant, not just midnight', () => {
    // dataRows.date always parses to UTC midnight, which a positive offset
    // (max +14h) can never roll into the next day, so this data shape alone
    // can't exercise an eastward boundary crossing. monthKey is a general
    // Date -> string utility, not a midnight-only one, so this proves it's
    // unconditionally UTC-anchored using a late-day UTC instant: 23:00 UTC
    // on Jan 31st is already Feb 1st in Pacific/Auckland (UTC+13).
    const restore = stubTz('Pacific/Auckland');
    try {
      expect(monthKey(new Date(Date.UTC(2026, 0, 31, 23, 0, 0)))).toBe('2026-01');
    } finally {
      restore();
    }
  });

  it('computeYearOverYear (via computeStats) attributes a Dec 31/Jan 1 UTC boundary row to the UTC year, not just the UTC month', () => {
    // The pre-fix bug misattributed the *year*, not only the month, for a
    // row sitting on a year boundary: computeYearOverYear buckets by
    // row.date.getUTCFullYear() first. A month-only regression case can't
    // catch a year-keying mistake.
    const restore = stubTz('America/New_York');
    try {
      function boundaryRevenueRow(year: number, amount: number) {
        return {
          id: _ccfRowId++,
          orgId: 1,
          datasetId: 1,
          sourceType: 'csv' as const,
          category: 'Revenue',
          parentCategory: 'Income' as const,
          date: new Date(Date.UTC(year, 0, 1)), // Jan 1st UTC midnight
          amount: amount.toFixed(2),
          label: null,
          metadata: null,
          createdAt: new Date(),
        };
      }
      const rows = [boundaryRevenueRow(2025, 1000), boundaryRevenueRow(2026, 1500)];

      const yoyStats = computeStats(rows).filter(
        (s): s is YearOverYearStat => s.statType === StatType.YearOverYear,
      );

      expect(yoyStats).toHaveLength(1);
      expect(yoyStats[0]!.details.month).toBe('Jan');
      expect(yoyStats[0]!.details.currentYearLabel).toBe('2026');
      expect(yoyStats[0]!.details.priorYearLabel).toBe('2025');
      expect(yoyStats[0]!.value).toBe(1500);
    } finally {
      restore();
    }
  });
});
