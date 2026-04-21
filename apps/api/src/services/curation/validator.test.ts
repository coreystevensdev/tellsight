import { describe, it, expect } from 'vitest';

import type { ComputedStat } from './types.js';
import { StatType } from './types.js';
import { validateSummary, validateStatRefs, stripInvalidStatRefs } from './validator.js';

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

function runwayStat(cashOnHand: number, monthlyNet: number, runwayMonths: number): ComputedStat {
  return {
    statType: StatType.Runway,
    category: null,
    value: runwayMonths,
    details: {
      cashOnHand,
      monthlyNet,
      runwayMonths,
      cashAsOfDate: '2026-04-15T00:00:00.000Z',
      confidence: 'high',
    },
  };
}

describe('validateSummary — Runway coverage', () => {
  it('accepts summaries that quote the exact cashOnHand', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = 'At this burn rate, your cash of $15,000 covers about 3 months of runway.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('flags a fabricated cashOnHand far from the actual value', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    // LLM invents $45,000 cash — not cashOnHand, not monthlyNet, not their sum
    const summary = 'Your cash balance of $45,000 gives you breathing room.';

    const report = validateSummary(summary, stats);
    expect(report.status).not.toBe('clean');
    expect(report.unmatchedNumbers.length).toBeGreaterThan(0);
  });

  it('does NOT flag numbers near cashOnHand ± monthlyNet (pairwise-sum tolerance)', () => {
    // $15,000 + $5,000 = $20,000 → inside the pairwise allowed-set. Known tolerance.
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = 'Projected depletion around $20,000 worth of spending.';

    const report = validateSummary(summary, stats);
    // Documents the coverage gap: pairwise sums mask nearby fabrications.
    expect(report.status).toBe('clean');
  });

  it('does NOT flag plain runway-month numbers (out of scanner scope)', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    // Fabricated runway ("5 months" vs actual 3) — scanner is currency/percent only,
    // so plain integer months are not checked. Documented deferral.
    const summary = 'You have roughly 5 months of runway at current burn.';

    const report = validateSummary(summary, stats);
    // No currency tokens present → nothing to flag → clean
    expect(report.status).toBe('clean');
  });

  it('flags a currency amount that matches nothing in the runway allowed-set', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = 'Revenue was around $87,345 for the period.';

    const report = validateSummary(summary, stats);
    expect(report.status).not.toBe('clean');
  });
});

describe('validateStatRefs', () => {
  it('returns no invalid refs when all tagged IDs match computed stat types', () => {
    const stats = [runwayStat(15000, -5000, 3), totalStat(629000)];
    const summary = 'Runway is 3 months <stat id="runway"/> and total is $629k <stat id="total"/>.';

    expect(validateStatRefs(summary, stats)).toEqual({ invalidRefs: [] });
  });

  it('flags ref IDs not present in the computed stats', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = 'Runway is 3 months <stat id="runaway"/> at this burn.';

    expect(validateStatRefs(summary, stats)).toEqual({ invalidRefs: ['runaway'] });
  });

  it('dedupes repeated invalid refs', () => {
    const stats = [totalStat(100)];
    const summary = '<stat id="bogus"/> hello <stat id="bogus"/> world';

    expect(validateStatRefs(summary, stats)).toEqual({ invalidRefs: ['bogus'] });
  });

  it('returns empty array when summary has no tags', () => {
    const stats = [totalStat(100)];
    expect(validateStatRefs('plain prose', stats)).toEqual({ invalidRefs: [] });
  });

  it('separates valid and invalid refs in mixed input', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = '<stat id="runway"/> ok and <stat id="ghost"/> nope.';

    expect(validateStatRefs(summary, stats)).toEqual({ invalidRefs: ['ghost'] });
  });
});

describe('stripInvalidStatRefs', () => {
  it('strips only the tags whose IDs are in invalidRefs', () => {
    const summary = '<stat id="runway"/> good <stat id="ghost"/> bad';
    expect(stripInvalidStatRefs(summary, ['ghost'])).toBe('<stat id="runway"/> good  bad');
  });

  it('returns the input unchanged when invalidRefs is empty', () => {
    const summary = '<stat id="runway"/> all good';
    expect(stripInvalidStatRefs(summary, [])).toBe(summary);
  });

  it('handles multiple invalid IDs in one pass', () => {
    const summary = 'a <stat id="x"/> b <stat id="y"/> c <stat id="runway"/> d';
    expect(stripInvalidStatRefs(summary, ['x', 'y'])).toBe('a  b  c <stat id="runway"/> d');
  });
});
