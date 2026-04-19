import { describe, it, expect } from 'vitest';

import type { ComputedStat } from './types.js';
import { StatType } from './types.js';
import { validateSummary } from './validator.js';

function totalStat(value: number, count = 12): ComputedStat {
  return {
    statType: StatType.Total,
    category: null,
    value,
    details: { scope: 'overall', count },
  };
}

function breakdown(value: number, percentage: number, total: number): ComputedStat {
  return {
    statType: StatType.CategoryBreakdown,
    category: 'Acme Corp',
    value,
    details: {
      percentage,
      absoluteTotal: total,
      transactionCount: 12,
      min: 18000,
      max: 52000,
    },
  };
}

function trend(growth: number, first: number, last: number): ComputedStat {
  return {
    statType: StatType.Trend,
    category: 'Acme Corp',
    value: 0,
    details: {
      slope: 0,
      intercept: first,
      growthPercent: growth,
      dataPoints: 12,
      firstValue: first,
      lastValue: last,
    },
  };
}

describe('validateSummary', () => {
  it('returns clean when every number in the summary matches a stat value', () => {
    const stats = [totalStat(629000), breakdown(520000, 83, 629000)];
    const summary = 'Revenue totaled $629,000 with Acme at 83% of the book.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
    expect(report.unmatchedNumbers).toHaveLength(0);
    expect(report.numbersChecked).toBe(2);
  });

  it('flags a hallucinated dollar amount as suspicious', () => {
    const stats = [totalStat(629000)];
    const summary = 'Your Q3 revenue was $87,000, a surprising jump.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('warnings');
    expect(report.unmatchedNumbers).toHaveLength(1);
    expect(report.unmatchedNumbers[0]!.value).toBe(87000);
    expect(report.unmatchedNumbers[0]!.kind).toBe('currency');
  });

  it('escalates to suspicious when three or more numbers are unmatched', () => {
    const stats = [totalStat(629000)];
    const summary = 'Revenue was $87k, margin is 42%, and churn hit 15%.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('suspicious');
    expect(report.unmatchedNumbers.length).toBeGreaterThanOrEqual(3);
  });

  it('allows pairwise sums of stat values (derived arithmetic)', () => {
    const stats: ComputedStat[] = [
      { statType: StatType.Total, category: 'Food', value: 400000, details: { scope: 'food', count: 100 } },
      { statType: StatType.Total, category: 'Drinks', value: 229000, details: { scope: 'drinks', count: 50 } },
    ];
    // 400000 + 229000 = 629000
    const summary = 'Combined revenue across both categories was $629,000.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
  });

  it('allows the v1.2 counterfactual remainder for concentration findings', () => {
    // Acme 83% of $629k → others = 629000 * 0.17 = 106930; /12 ≈ 8911
    const stats = [breakdown(520000, 83, 629000)];
    const summary = 'If Acme stepped back, the remaining book runs closer to $8,900/month.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
  });

  it('accepts k/M suffix variants of stat values within tolerance', () => {
    const stats = [totalStat(63000)];
    const summary = 'December closed at $63k, a strong finish.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
  });

  it('accepts rounded values within the default 2% tolerance', () => {
    // stat is 62,987 but LLM rounds to 63,000 — diff is 0.02%, well under tolerance
    const stats = [totalStat(62987)];
    const summary = 'Revenue came in at $63,000 for the period.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
  });

  it('rejects values outside tolerance even when close', () => {
    // stat is 50,000, summary says $60k — 20% off, well outside 2%
    const stats = [totalStat(50000)];
    const summary = 'Revenue was around $60,000 this month.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('warnings');
    expect(report.unmatchedNumbers[0]!.value).toBe(60000);
  });

  it('flags percentages not present in the stats', () => {
    const stats = [breakdown(520000, 83, 629000)];
    const summary = 'Acme is 95% of your revenue this year.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('warnings');
    expect(report.unmatchedNumbers[0]!.kind).toBe('percent');
    expect(report.unmatchedNumbers[0]!.value).toBe(95);
  });

  it('captures context around each unmatched number for debugging', () => {
    const stats = [totalStat(100000)];
    const summary = 'This month we hit a milestone of $87,500 in recurring revenue.';

    const report = validateSummary(summary, stats);

    expect(report.unmatchedNumbers[0]!.context).toContain('$87,500');
  });

  it('handles multi-stat fixtures (Acme scenario end-to-end)', () => {
    const stats = [
      totalStat(629000),
      breakdown(520000, 83, 629000),
      trend(188, 18000, 52000),
    ];
    const summary =
      'Revenue grew 188% year-over-year to $629,000, but Acme was 83% of the book. ' +
      'If they step back, your remainder runs closer to $8,900/month.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
    expect(report.numbersChecked).toBeGreaterThan(3);
  });

  it('returns clean on an empty summary', () => {
    const stats = [totalStat(629000)];
    const report = validateSummary('', stats);

    expect(report.status).toBe('clean');
    expect(report.numbersChecked).toBe(0);
  });

  it('reports empty stats produce zero allowed values but still runs', () => {
    const summary = 'Revenue was $500,000.';
    const report = validateSummary(summary, []);

    expect(report.allowedValueCount).toBe(0);
    expect(report.status).toBe('warnings');
  });
});
