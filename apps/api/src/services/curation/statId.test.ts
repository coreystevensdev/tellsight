import { describe, it, expect } from 'vitest';

import { computeStats, statInstanceId, assignIds } from './computation.js';
import { citeTagCapture } from 'shared/constants';
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

  it('falls back to _ for an undefined category, matching how a raw jsonb-cast stat without runtime validation could reach this function', () => {
    // getLastDigest's keyStats cast (row.keyStats as ComputedStat[]) has no runtime
    // validation, so a legacy row missing `category` entirely could reach here
    // despite ComputedStat's type saying `string | null`, not `string | null | undefined`.
    const totalStat = {
      statType: StatType.Total,
      value: 7000,
      details: { scope: 'overall', count: 9 },
    } as unknown as ComputedStat;
    expect(statInstanceId(totalStat, 1)).toBe('1:total:_:overall');
  });

  it('uses an empty segment for an empty-string category, distinct from the _ used for null', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: '',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total::category');
  });

  it('gives category: \'\' and category: null distinct ids', () => {
    const emptyStringCategory: ComputedStat = {
      statType: StatType.Total,
      category: '',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    const nullCategory: ComputedStat = {
      statType: StatType.Total,
      category: null,
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    expect(statInstanceId(emptyStringCategory, 1)).not.toBe(statInstanceId(nullCategory, 1));
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

  it('swaps a literal quote in the category for a smart quote so the resulting id round-trips through citeTagCapture', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: 'Bob\'s "Best" Coffee',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    const id = statInstanceId(totalStat, 1);

    expect(id).not.toContain('"');
    expect(id).toBe(`1:total:Bob's ”Best” Coffee:category`);

    const tag = `<cite id="${id}"/>`;
    const matches = [...tag.matchAll(citeTagCapture())];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1]).toBe(id);
  });

  it('does not collapse a quote-only category to the empty string', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: '"',
      value: 500,
      details: { scope: 'category', count: 1 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total:”:category');
  });

  it('gives two categories differing only by an embedded quote distinct ids', () => {
    const withQuote: ComputedStat = {
      statType: StatType.Total,
      category: 'Bob"s Cafe',
      value: 100,
      details: { scope: 'category', count: 1 },
    };
    const withoutQuote: ComputedStat = {
      statType: StatType.Total,
      category: 'Bobs Cafe',
      value: 200,
      details: { scope: 'category', count: 1 },
    };
    expect(statInstanceId(withQuote, 1)).not.toBe(statInstanceId(withoutQuote, 1));
  });

  it('swaps a literal colon in the category for a fullwidth colon so the field boundaries stay stable', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: 'Coffee: Retail',
      value: 7000,
      details: { scope: 'category', count: 6 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total:Coffee： Retail:category');
  });

  it('does not collapse a colon-only category to the empty string', () => {
    const totalStat: ComputedStat = {
      statType: StatType.Total,
      category: ':',
      value: 500,
      details: { scope: 'category', count: 1 },
    };
    expect(statInstanceId(totalStat, 1)).toBe('1:total:：:category');
  });

  it('gives two categories differing only by an embedded colon distinct ids', () => {
    const withColon: ComputedStat = {
      statType: StatType.Total,
      category: 'Bob:s Cafe',
      value: 100,
      details: { scope: 'category', count: 1 },
    };
    const withoutColon: ComputedStat = {
      statType: StatType.Total,
      category: 'Bobs Cafe',
      value: 200,
      details: { scope: 'category', count: 1 },
    };
    expect(statInstanceId(withColon, 1)).not.toBe(statInstanceId(withoutColon, 1));
  });

  it('known limitation: a category already containing the fullwidth colon lookalike collides with an escaped ASCII colon (DW-32 follow-up, not fixed here)', () => {
    const alreadyFullwidth: ComputedStat = {
      statType: StatType.Total,
      category: 'Coffee： Retail',
      value: 100,
      details: { scope: 'category', count: 1 },
    };
    const escapedAscii: ComputedStat = {
      statType: StatType.Total,
      category: 'Coffee: Retail',
      value: 200,
      details: { scope: 'category', count: 1 },
    };
    // documents the current behavior rather than asserting it's correct --
    // character substitution isn't injective when the substitute character
    // can also occur in raw input, same pre-existing gap as the quote swap.
    expect(statInstanceId(alreadyFullwidth, 1)).toBe(statInstanceId(escapedAscii, 1));
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

  it('deep-copies details so mutating an IdentifiedStat cannot corrupt the underlying ComputedStat', () => {
    const cashFlow: ComputedStat = {
      statType: StatType.CashFlow,
      category: null,
      value: 200,
      details: {
        monthlyNet: 200,
        trailingMonths: 3,
        direction: 'surplus',
        monthsBurning: 0,
        recentMonths: [{ month: '2026-01', revenue: 1000, expenses: 800, net: 200 }],
      },
    };
    const [identified] = assignIds([cashFlow], 1);
    if (identified?.statType !== StatType.CashFlow || cashFlow.statType !== StatType.CashFlow) {
      throw new Error('expected cash_flow stat');
    }

    expect(identified.value).toBe(cashFlow.value);
    expect(identified.category).toBe(cashFlow.category);
    expect(identified.details).not.toBe(cashFlow.details);
    expect(identified.details.recentMonths).not.toBe(cashFlow.details.recentMonths);
    expect(identified.details).toEqual(cashFlow.details);

    identified.details.recentMonths[0]!.net = 999;
    expect(cashFlow.details.recentMonths[0]!.net).toBe(200);
  });

  // Beyond CashFlow, cover every other statType whose details holds a nested
  // array or object, since only those shapes can actually expose a shared-identity
  // bug -- the flat-primitive detail shapes (total, average, trend, etc.) have
  // nothing nested for a shallow copy to leak.
  it('deep-copies nested arrays in cash_forecast and seasonal_projection details', () => {
    const cashForecast: ComputedStat = {
      statType: StatType.CashForecast,
      category: null,
      value: -500,
      details: {
        startingBalance: 10000,
        asOfDate: '2026-07-01',
        method: 'linear_regression',
        slope: -100,
        intercept: 10000,
        basisMonths: ['2026-04', '2026-05', '2026-06'],
        basisValues: [200, 100, -100],
        projectedMonths: [{ month: '2026-08', projectedNet: -500, projectedBalance: 9500 }],
        crossesZeroAtMonth: null,
        confidence: 'moderate',
      },
    };
    const seasonal: ComputedStat = {
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
    const [identifiedForecast, identifiedSeasonal] = assignIds([cashForecast, seasonal], 1);
    if (identifiedForecast?.statType !== StatType.CashForecast || cashForecast.statType !== StatType.CashForecast) {
      throw new Error('expected cash_forecast stat');
    }
    if (identifiedSeasonal?.statType !== StatType.SeasonalProjection || seasonal.statType !== StatType.SeasonalProjection) {
      throw new Error('expected seasonal_projection stat');
    }

    expect(identifiedForecast.details.basisMonths).not.toBe(cashForecast.details.basisMonths);
    expect(identifiedForecast.details.projectedMonths).not.toBe(cashForecast.details.projectedMonths);
    identifiedForecast.details.projectedMonths[0]!.projectedNet = 0;
    expect(cashForecast.details.projectedMonths[0]!.projectedNet).toBe(-500);

    expect(identifiedSeasonal.details.basisMonths).not.toBe(seasonal.details.basisMonths);
    expect(identifiedSeasonal.details.basisValues).not.toBe(seasonal.details.basisValues);
    identifiedSeasonal.details.basisValues[0] = 0;
    expect(seasonal.details.basisValues[0]).toBe(1000);
  });

  it('deep-copies the nested iqrBounds object in anomaly details', () => {
    const anomaly: ComputedStat = {
      statType: StatType.Anomaly,
      category: 'Sales',
      value: 500,
      details: { direction: 'above', zScore: 3.1, iqrBounds: { lower: 100, upper: 400 }, deviation: 100 },
    };
    const [identified] = assignIds([anomaly], 1);
    if (identified?.statType !== StatType.Anomaly || anomaly.statType !== StatType.Anomaly) {
      throw new Error('expected anomaly stat');
    }

    expect(identified.details.iqrBounds).not.toBe(anomaly.details.iqrBounds);
    identified.details.iqrBounds.upper = 999;
    expect(anomaly.details.iqrBounds.upper).toBe(400);
  });
});
