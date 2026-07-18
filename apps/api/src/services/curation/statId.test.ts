import { describe, it, expect } from 'vitest';

import { computeStats, statInstanceId, assignIds } from './computation.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

// Minimal rows that feed computeStats() for the assignIds integration tests
// below. All rows have parentCategory: null, so only totals/averages/trends/
// anomalies/category breakdowns are produced -- year-over-year, seasonal
// projection, and cash-flow-derived stats need parentCategory: 'Income' or
// 'Expenses' and are exercised separately below via hand-built stat objects.
const rows = [
  { id: 1, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-01-01'), amount: '1000.00', label: null, metadata: null, createdAt: new Date() },
  { id: 2, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-02-01'), amount: '1100.00', label: null, metadata: null, createdAt: new Date() },
  { id: 3, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2025-03-01'), amount: '1200.00', label: null, metadata: null, createdAt: new Date() },
  { id: 4, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-01-01'), amount: '1300.00', label: null, metadata: null, createdAt: new Date() },
  { id: 5, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-02-01'), amount: '1400.00', label: null, metadata: null, createdAt: new Date() },
  { id: 6, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Sales', parentCategory: null, date: new Date('2026-03-01'), amount: '9000.00', label: null, metadata: null, createdAt: new Date() },
  { id: 7, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-01-01'), amount: '500.00', label: null, metadata: null, createdAt: new Date() },
  { id: 8, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-02-01'), amount: '520.00', label: null, metadata: null, createdAt: new Date() },
  { id: 9, orgId: 1, datasetId: 1, sourceType: 'csv' as const, category: 'Expenses', parentCategory: null, date: new Date('2026-03-01'), amount: '510.00', label: null, metadata: null, createdAt: new Date() },
];

describe('statInstanceId', () => {
  it('produces a readable key in the expected format', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: 'Sales',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total:Sales:category');
  });

  it('uses _ for null category', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: null,
      value: 7000,
      details: { scope: 'overall', count: 9 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total:_:overall');
  });

  it('includes datasetId so ids are cross-dataset distinct', () => {
    const stat: ComputedStat = {
      statType: StatType.Total,
      category: 'Sales',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    expect(statInstanceId(stat, 1)).not.toBe(statInstanceId(stat, 2));
  });

  it('discriminates average stats by scope', () => {
    const avgStat: ComputedStat = {
      statType: StatType.Average,
      category: 'Expenses',
      value: 500,
      details: { scope: 'category', median: 500 },
    };
    expect(statInstanceId(avgStat, 1)).toBe('1:average:Expenses:category');
  });

  it('discriminates year-over-year stats by currentYear-month', () => {
    const yoyStat: ComputedStat = {
      statType: StatType.YearOverYear,
      category: 'Sales',
      value: 15,
      details: {
        currentYear: 1300,
        priorYear: 1130,
        currentYearLabel: '2026',
        priorYearLabel: '2025',
        changePercent: 15,
        month: 'January',
      },
    };
    expect(statInstanceId(yoyStat, 1)).toBe('1:year_over_year:Sales:1300-January');
  });

  it('discriminates seasonal projection stats by projectedMonth', () => {
    const seasonalStat: ComputedStat = {
      statType: StatType.SeasonalProjection,
      category: 'Sales',
      value: 1500,
      details: {
        projectedMonth: 'April',
        projectedAmount: 1500,
        basisMonths: ['January', 'February', 'March'],
        basisValues: [1000, 1100, 1200],
        confidence: 'moderate',
      },
    };
    expect(statInstanceId(seasonalStat, 1)).toBe('1:seasonal_projection:Sales:April');
  });

  it('discriminates cash flow stats by trailing window size', () => {
    const cashFlowStat: ComputedStat = {
      statType: StatType.CashFlow,
      category: null,
      value: 200,
      details: {
        monthlyNet: 200,
        trailingMonths: 3,
        direction: 'surplus',
        monthsBurning: 0,
        recentMonths: [],
      },
    };
    expect(statInstanceId(cashFlowStat, 1)).toBe('1:cash_flow:_:w3');
  });
});

describe('assignIds', () => {
  it('assigns an id to every stat', () => {
    const stats = computeStats(rows);
    const identified = assignIds(stats, 1);
    expect(identified.length).toBeGreaterThan(0);
    for (const s of identified) {
      expect(s.id).toBeTruthy();
    }
  });

  it('is deterministic: same rows produce the same ids', () => {
    const a = assignIds(computeStats(rows), 1);
    const b = assignIds(computeStats(rows), 1);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it('ids are unique within a dataset', () => {
    const identified = assignIds(computeStats(rows), 1);
    const ids = identified.map((s) => s.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('cross-dataset ids are distinct for the same stat type', () => {
    const a = assignIds(computeStats(rows), 1);
    const b = assignIds(computeStats(rows), 2);
    const aIds = new Set(a.map((s) => s.id));
    const bIds = new Set(b.map((s) => s.id));
    // no overlap between the two datasets
    for (const id of bIds) {
      expect(aIds.has(id)).toBe(false);
    }
  });

  it('dedupes byte-identical anomaly stats', () => {
    const anomaly: ComputedStat = {
      statType: StatType.Anomaly,
      category: 'Sales',
      value: 500,
      details: { direction: 'above', zScore: 3.1, iqrBounds: { lower: 100, upper: 400 }, deviation: 100 },
    };
    // two identical anomaly objects, same value -> same id
    const identified = assignIds([anomaly, { ...anomaly }], 1);
    expect(identified).toHaveLength(1);
  });

  it('does not mutate the original stats', () => {
    const stats = computeStats(rows);
    const original = stats.map((s) => ({ ...s }));
    assignIds(stats, 1);
    expect(stats).toEqual(original);
  });
});
