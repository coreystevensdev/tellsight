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
    // stat is 62,987 but LLM rounds to 63,000, diff is 0.02%, well under tolerance
    const stats = [totalStat(62987)];
    const summary = 'Revenue came in at $63,000 for the period.';

    const report = validateSummary(summary, stats);

    expect(report.status).toBe('clean');
  });

  it('rejects values outside tolerance even when close', () => {
    // stat is 50,000, summary says $60k, 20% off, well outside 2%
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

describe('validateSummary, Runway coverage', () => {
  it('accepts summaries that quote the exact cashOnHand', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    const summary = 'At this burn rate, your cash of $15,000 covers about 3 months of runway.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('flags a fabricated cashOnHand far from the actual value', () => {
    const stats = [runwayStat(15000, -5000, 3)];
    // LLM invents $45,000 cash, not cashOnHand, not monthlyNet, not their sum
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
    // Fabricated runway ("5 months" vs actual 3), scanner is currency/percent only,
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

function breakEvenStat(
  breakEvenRevenue: number,
  monthlyFixedCosts: number,
  currentMonthlyRevenue: number,
  marginPercent: number,
): ComputedStat {
  return {
    statType: StatType.BreakEven,
    category: null,
    value: breakEvenRevenue,
    details: {
      monthlyFixedCosts,
      marginPercent,
      breakEvenRevenue,
      currentMonthlyRevenue,
      gap: breakEvenRevenue - currentMonthlyRevenue,
      confidence: 'high',
    },
  };
}

describe('validateSummary, BreakEven coverage', () => {
  it('accepts a summary quoting the exact breakEvenRevenue', () => {
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20)];
    const summary = 'To cover your fixed costs at your current margin, you\'d need about $75,000/mo in revenue.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('accepts a summary quoting the exact monthlyFixedCosts', () => {
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20)];
    const summary = 'Your $15,000/mo in fixed costs sets the floor.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('flags a fabricated breakEvenRevenue far from any allowed value', () => {
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20)];
    // LLM invents $120k break-even, not in allowed set, not pairwise.
    const summary = 'Your break-even target is about $120,000/mo.';

    const report = validateSummary(summary, stats);
    expect(report.status).not.toBe('clean');
    expect(report.unmatchedNumbers.length).toBeGreaterThan(0);
  });

  it('does NOT flag a gap value that matches breakEvenRevenue - currentMonthlyRevenue (pairwise tolerance)', () => {
    // breakEven 75k - currentRevenue 50k = 25k → covered by pairwise-sum loop.
    // Documents the coverage gap: a fabricated gap close to |be - revenue| slips through.
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20)];
    const summary = 'The gap between current revenue and break-even is about $25,000/mo.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('does NOT flag marginPercent, covered by MarginTrend classification, not BreakEven', () => {
    // marginPercent goes through StatType.MarginTrend when both stats are present.
    // Here we pair BreakEven with MarginTrend so the percent lands in the allowed-set.
    const marginTrend: ComputedStat = {
      statType: StatType.MarginTrend,
      category: null,
      value: 20,
      details: {
        recentMarginPercent: 20,
        priorMarginPercent: 20,
        direction: 'stable',
        revenueGrowthPercent: 0,
        expenseGrowthPercent: 0,
      },
    };
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20), marginTrend];
    const summary = 'At your 20% margin, break-even is $75,000/mo.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('flags a currency amount that matches nothing in the break-even allowed-set', () => {
    const stats = [breakEvenStat(75_000, 15_000, 50_000, 20)];
    const summary = 'Last quarter\'s revenue came in around $87,345.';

    const report = validateSummary(summary, stats);
    expect(report.status).not.toBe('clean');
  });
});

function forecastStat(
  startingBalance: number,
  projected: { net: number; balance: number }[],
  crossesZeroAtMonth: number | null = null,
): ComputedStat {
  return {
    statType: StatType.CashForecast,
    category: null,
    value: projected[projected.length - 1]?.balance ?? startingBalance,
    details: {
      startingBalance,
      asOfDate: '2026-06-01T00:00:00.000Z',
      method: 'linear_regression',
      slope: 0,
      intercept: projected[0]?.net ?? 0,
      basisMonths: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
      basisValues: [-10000, -10000, -10000, -10000, -10000, -10000],
      projectedMonths: projected.map((p, i) => ({
        month: `2026-${String(7 + i).padStart(2, '0')}`,
        projectedNet: p.net,
        projectedBalance: p.balance,
      })),
      crossesZeroAtMonth,
      confidence: 'high',
    },
  };
}

describe('validateSummary, CashForecast coverage', () => {
  it('accepts a summary quoting the exact startingBalance and each projected balance', () => {
    const stats = [forecastStat(58_000, [
      { net: -17_000, balance: 41_000 },
      { net: -18_000, balance: 23_000 },
      { net: -18_000, balance: 5_000 },
    ])];
    const summary =
      'Your balance sits at $58,000 today and tracks toward $41,000, then $23,000, then $5,000 by month three.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('handles negative projected balances by matching their absolute magnitude in prose', () => {
    // balance crosses zero, LLM renders "-$5,000" which the currency regex picks up as 5000
    const stats = [forecastStat(25_000, [
      { net: -10_000, balance: 15_000 },
      { net: -10_000, balance: 5_000 },
      { net: -10_000, balance: -5_000 },
    ], 3)];
    const summary =
      'Balance trends from $25,000 to $15,000, then $5,000, and crosses into -$5,000 territory by month three.';

    const report = validateSummary(summary, stats);
    expect(report.status).toBe('clean');
  });

  it('flags a fabricated projected balance far from the trajectory', () => {
    const stats = [forecastStat(58_000, [
      { net: -17_000, balance: 41_000 },
      { net: -18_000, balance: 23_000 },
      { net: -18_000, balance: 5_000 },
    ])];
    const summary = 'Your forecast suggests ending at about $95,000 in three months.';

    const report = validateSummary(summary, stats);
    expect(report.status).not.toBe('clean');
    expect(report.unmatchedNumbers.length).toBeGreaterThan(0);
  });

  it('does NOT push slope/intercept into the allowed-set, regression coefficients are not for the LLM to quote', () => {
    // slope is 0 here (rolling-mean fallback shape), but the test proves the principle:
    // a number that matches *only* the slope should be flagged.
    const stats = [forecastStat(58_000, [
      { net: -17_000, balance: 41_000 },
      { net: -18_000, balance: 23_000 },
      { net: -18_000, balance: 5_000 },
    ])];
    // $500 matches no balance, no net, no pairwise combo
    const summary = 'A slope coefficient of $500 per month underlies the forecast.';

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
