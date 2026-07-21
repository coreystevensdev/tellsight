import { describe, it, expect } from 'vitest';

import type { ComputedStat } from '../../services/curation/types.js';
import {
  buildPriorContext,
  SIGNIFICANT_RUNWAY_DELTA_MONTHS,
  SIGNIFICANT_MARGIN_DELTA_PP,
  SIGNIFICANT_BURN_DELTA_PERCENT,
} from './buildPriorContext.js';

function runway(runwayMonths: number): ComputedStat {
  return {
    statType: 'runway',
    category: null,
    value: runwayMonths,
    details: {
      cashOnHand: 12000,
      monthlyNet: -2000,
      runwayMonths,
      cashAsOfDate: '2026-06-01',
      confidence: 'high',
      trailingMonths: 3,
    },
  };
}

function breakEven(gap: number): ComputedStat {
  return {
    statType: 'break_even',
    category: null,
    value: gap,
    details: {
      monthlyFixedCosts: 8000,
      marginPercent: 20,
      breakEvenRevenue: 40000,
      currentMonthlyRevenue: 40000 - gap,
      gap,
      confidence: 'high',
    },
  };
}

function cashFlow(monthlyNet: number): ComputedStat {
  return {
    statType: 'cash_flow',
    category: null,
    value: monthlyNet,
    details: {
      monthlyNet,
      trailingMonths: 6,
      direction: monthlyNet < 0 ? 'burning' : 'surplus',
      monthsBurning: monthlyNet < 0 ? 4 : 0,
      recentMonths: [],
    },
  };
}

function margin(recentMarginPercent: number): ComputedStat {
  return {
    statType: 'margin_trend',
    category: null,
    value: recentMarginPercent,
    details: {
      recentMarginPercent,
      priorMarginPercent: recentMarginPercent,
      direction: 'stable',
      revenueGrowthPercent: 5,
      expenseGrowthPercent: 5,
    },
  };
}

function categoryBreakdown(category: string): ComputedStat {
  return {
    statType: 'category_breakdown',
    category,
    value: 30000,
    details: { percentage: 60, absoluteTotal: 30000, transactionCount: 12, min: 2000, max: 4000 },
  };
}

function cashForecast(crossesZeroAtMonth: number | null): ComputedStat {
  return {
    statType: 'cash_forecast',
    category: null,
    value: 0,
    details: {
      startingBalance: 12000,
      asOfDate: '2026-06-01',
      method: 'linear_regression',
      slope: -500,
      intercept: 12000,
      basisMonths: [],
      basisValues: [],
      projectedMonths: [],
      crossesZeroAtMonth,
      confidence: 'high',
    },
  };
}

describe('buildPriorContext', () => {
  it('returns [] when both snapshots are empty', () => {
    expect(buildPriorContext([], [])).toEqual([]);
  });

  it.each([
    ['runway improved well past threshold', [runway(5.0)], [runway(4.0)], [{ statType: 'runway', kind: 'delta' }]],
    ['runway declined well past threshold', [runway(3.0)], [runway(4.0)], [{ statType: 'runway', kind: 'delta' }]],
    ['runway change below threshold', [runway(4.1)], [runway(4.0)], []],
    [
      'runway change exactly at threshold (inclusive)',
      [runway(4.0 + SIGNIFICANT_RUNWAY_DELTA_MONTHS)],
      [runway(4.0)],
      [{ statType: 'runway', kind: 'delta' }],
    ],
  ] as const)('%s', (_, current, prior, expected) => {
    expect(buildPriorContext(current, prior)).toMatchObject(expected);
  });

  it.each([
    ['margin change well past threshold', [margin(22.0)], [margin(20.0)], [{ statType: 'margin_trend', kind: 'delta' }]],
    ['margin change below threshold', [margin(20.4)], [margin(20.0)], []],
    [
      'margin change exactly at threshold (inclusive)',
      [margin(20.0 + SIGNIFICANT_MARGIN_DELTA_PP)],
      [margin(20.0)],
      [{ statType: 'margin_trend', kind: 'delta' }],
    ],
  ] as const)('%s', (_, current, prior, expected) => {
    expect(buildPriorContext(current, prior)).toMatchObject(expected);
  });

  it.each([
    ['cash flow burn from zero (zero-guard)', [cashFlow(-500)], [cashFlow(0)], [{ statType: 'cash_flow', kind: 'delta' }]],
    ['cash flow both zero (zero-guard)', [cashFlow(0)], [cashFlow(0)], []],
    ['cash flow change below burn threshold', [cashFlow(-2050)], [cashFlow(-2000)], []],
    [
      'cash flow change at exact burn threshold (inclusive)',
      [cashFlow(-2000 * (1 + SIGNIFICANT_BURN_DELTA_PERCENT / 100))],
      [cashFlow(-2000)],
      [{ statType: 'cash_flow', kind: 'delta' }],
    ],
  ] as const)('%s', (_, current, prior, expected) => {
    expect(buildPriorContext(current, prior)).toMatchObject(expected);
  });

  it.each([
    ['runway appears', [runway(4.0)], [], [{ statType: 'runway', kind: 'first_tracked' }]],
    ['break_even appears', [breakEven(500)], [], [{ statType: 'break_even', kind: 'first_tracked' }]],
    ['cash_flow appears', [cashFlow(-500)], [], [{ statType: 'cash_flow', kind: 'first_tracked' }]],
    ['margin_trend appears', [margin(20.0)], [], [{ statType: 'margin_trend', kind: 'first_tracked' }]],
  ] as const)('HIGH_IMPORTANCE stat appears: %s', (_, current, prior, expected) => {
    expect(buildPriorContext(current, prior)).toMatchObject(expected);
  });

  it.each([
    ['runway disappears', [], [runway(4.0)]],
    ['break_even disappears', [], [breakEven(500)]],
    ['cash_flow disappears', [], [cashFlow(-500)]],
    ['margin_trend disappears', [], [margin(20.0)]],
  ] as const)('HIGH_IMPORTANCE stat disappears (v1 suppression): %s', (_, current, prior) => {
    expect(buildPriorContext(current, prior)).toEqual([]);
  });

  it('break_even present both weeks never emits a delta, even when the gap changes a lot', () => {
    expect(buildPriorContext([breakEven(-200)], [breakEven(500)])).toEqual([]);
  });

  it('cash_forecast present both weeks never emits an entry, even when the crossing shifts', () => {
    expect(buildPriorContext([cashForecast(3)], [cashForecast(null)])).toEqual([]);
  });

  it('cash_forecast appearing or disappearing never emits an entry', () => {
    expect(buildPriorContext([cashForecast(3)], [])).toEqual([]);
    expect(buildPriorContext([], [cashForecast(3)])).toEqual([]);
  });

  it('non-HIGH_IMPORTANCE stats are ignored regardless of category churn between weeks', () => {
    expect(buildPriorContext([categoryBreakdown('Utilities')], [categoryBreakdown('Rent')])).toEqual([]);
    expect(buildPriorContext([categoryBreakdown('Rent')], [categoryBreakdown('Utilities')])).toEqual([]);
  });

  it('non-HIGH_IMPORTANCE stats are ignored regardless of presence in either snapshot', () => {
    expect(buildPriorContext([categoryBreakdown('Rent')], [])).toEqual([]);
    expect(buildPriorContext([], [categoryBreakdown('Rent')])).toEqual([]);
  });

  it('assembles multiple entries in statType order (runway, cash_flow, margin_trend) when several HIGH_IMPORTANCE stats move at once', () => {
    const result = buildPriorContext(
      [runway(5.0), cashFlow(-2200), margin(22.0), breakEven(-200)],
      [runway(4.0), cashFlow(-2000), margin(20.0), breakEven(500)],
    );
    expect(result).toEqual([
      { statType: 'runway', kind: 'delta', text: expect.any(String) },
      { statType: 'cash_flow', kind: 'delta', text: expect.any(String) },
      { statType: 'margin_trend', kind: 'delta', text: expect.any(String) },
    ]);
  });

  it('matches the spec Design Notes example: runway delta emitted, sub-threshold margin change suppressed', () => {
    const result = buildPriorContext([runway(4.5), margin(20.0)], [runway(4.0), margin(19.8)]);
    expect(result).toEqual([{ statType: 'runway', kind: 'delta', text: expect.stringContaining('4.0') }]);
  });
});
