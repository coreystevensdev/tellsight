import { describe, it, expect } from 'vitest';

import { computeStats, statInstanceId, assignIds } from './computation.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

// Minimal rows that produce a variety of stat types: totals, averages, trends,
// anomalies, year-over-year, and category breakdowns.
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
