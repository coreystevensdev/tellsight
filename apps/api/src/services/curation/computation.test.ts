import { describe, it, expect } from 'vitest';

import { computeStats, computeRunway, runwayConfidence, computeBreakEven, breakEvenConfidence } from './computation.js';
import type { ComputedStat, CashFlowStat, RunwayStat, BreakEvenStat, MarginTrendStat } from './types.js';
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

  it('handles single-row category — total and average only, no trend/anomaly', () => {
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

  it('handles all-same-amount data — no anomalies, flat trend', () => {
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

  it('respects trendMinPoints option — suppresses trends below threshold', () => {
    const stats = computeStats(fixture.multiCategory, { trendMinPoints: 5 });
    const trends = stats.filter((s) => s.statType === StatType.Trend);

    // multiCategory has 4 rows per category — below threshold of 5
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
  // Skip the Income row when revenue is explicitly 0 — that's how the "zero-revenue month"
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
  it('emits burning stat for 3 consecutive loss months — median of sorted nets is the middle element', () => {
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

  it('mixed window with median cleanly burning — direction burning, monthsBurning 2', () => {
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

  it('mixed window with median near zero — suppressed (break-even companion fixture)', () => {
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
    // negative-income fixture (refund/chargeback adjustment) — it's the only way to
    // reach the second guard without triggering the first, since Map.get(m) ?? 0
    // makes genuine-zero months look identical to missing-income-row months.
    const rows = [
      ...ccfMonth(2026, 1, 100, 5000),
      ...ccfMonth(2026, 2, 100, 5000),
      ...ccfMonth(2026, 3, -200, 5000),
    ];
    expect(cashFlowStat(rows)).toBeNull();
  });

  it('service business (expense-only mirror case) — emits surplus, not suppressed', () => {
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

  it('window N=3 — median is the middle element of sorted nets', () => {
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

  it('window N=6 — median is mean of two middle elements', () => {
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

  it('median robustness — one outlier month does not flip direction', () => {
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

  it('recentMonths carries only aggregated shape — no row-level leaks', () => {
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

// Anchor wall-clock date for staleness math — 2026-05-01.
const NOW = new Date('2026-05-01T00:00:00.000Z');

function daysAgoISO(days: number): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

describe('runwayConfidence', () => {
  it('high — fresh cash AND sustained burn', () => {
    expect(runwayConfidence(10, 3)).toBe('high');
    expect(runwayConfidence(30, 2)).toBe('high');
  });

  it('moderate — slightly stale OR single-month burn', () => {
    expect(runwayConfidence(45, 3)).toBe('moderate');
    expect(runwayConfidence(30, 1)).toBe('moderate');
  });

  it('low — stale beyond 90 days OR no burn months counted', () => {
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

  it('emits with low confidence at 91–180 day staleness', () => {
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

  it('break-even details carry only numbers and confidence enum — no row-level leak', () => {
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
