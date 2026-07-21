import { describe, it, expect } from 'vitest';

import type { ComputedStat, CashFlowDetails, MarginTrendDetails } from '../../services/curation/types.js';
import { detectTransitionMilestones } from './milestones.js';

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

function cashFlow(direction: CashFlowDetails['direction']): ComputedStat {
  return {
    statType: 'cash_flow',
    category: null,
    value: direction === 'burning' ? -2000 : 2000,
    details: {
      monthlyNet: direction === 'burning' ? -2000 : 2000,
      trailingMonths: 6,
      direction,
      monthsBurning: direction === 'burning' ? 4 : 0,
      recentMonths: [],
    },
  };
}

function margin(direction: MarginTrendDetails['direction']): ComputedStat {
  return {
    statType: 'margin_trend',
    category: null,
    value: 18,
    details: {
      recentMarginPercent: 18,
      priorMarginPercent: 20,
      direction,
      revenueGrowthPercent: 5,
      expenseGrowthPercent: 8,
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

function forecast(crossesZeroAtMonth: number | null): ComputedStat {
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

describe('detectTransitionMilestones', () => {
  it('returns [] when both snapshots are empty', () => {
    expect(detectTransitionMilestones([], [])).toEqual([]);
  });

  it('turned_cash_positive fires burning to surplus', () => {
    expect(detectTransitionMilestones([cashFlow('surplus')], [cashFlow('burning')])).toEqual([
      { kind: 'turned_cash_positive', label: 'You turned cash-flow positive.', statType: 'cash_flow' },
    ]);
  });

  it('turned_cash_negative fires surplus to burning', () => {
    expect(detectTransitionMilestones([cashFlow('burning')], [cashFlow('surplus')])).toEqual([
      { kind: 'turned_cash_negative', label: 'You started burning cash this month.', statType: 'cash_flow' },
    ]);
  });

  it('no cash-flow milestone when direction is unchanged', () => {
    expect(detectTransitionMilestones([cashFlow('burning')], [cashFlow('burning')])).toEqual([]);
  });

  it('crossed_break_even fires gap > 0 to <= 0', () => {
    expect(detectTransitionMilestones([breakEven(0)], [breakEven(500)])).toEqual([
      { kind: 'crossed_break_even', label: 'Revenue now covers your fixed costs.', statType: 'break_even' },
    ]);
  });

  it('no break_even milestone when gap stays above zero', () => {
    expect(detectTransitionMilestones([breakEven(200)], [breakEven(500)])).toEqual([]);
  });

  it('runway_extended_past_6mo fires < 6 to >= 6', () => {
    expect(detectTransitionMilestones([runway(6.0)], [runway(5.5)])).toEqual([
      { kind: 'runway_extended_past_6mo', label: 'Your runway extended past 6 months.', statType: 'runway' },
    ]);
  });

  it('runway_dropped_below_3mo fires >= 3 to < 3', () => {
    expect(detectTransitionMilestones([runway(2.8)], [runway(3.5)])).toEqual([
      { kind: 'runway_dropped_below_3mo', label: 'Your runway dropped below 3 months.', statType: 'runway' },
    ]);
  });

  it('no runway milestone when the change stays within the 3-6 band', () => {
    expect(detectTransitionMilestones([runway(4.5)], [runway(4.0)])).toEqual([]);
  });

  it('margin_turned_expanding fires shrinking to expanding', () => {
    expect(detectTransitionMilestones([margin('expanding')], [margin('shrinking')])).toEqual([
      { kind: 'margin_turned_expanding', label: 'Your margin started expanding.', statType: 'margin_trend' },
    ]);
  });

  it('no margin milestone when moving from stable to expanding', () => {
    expect(detectTransitionMilestones([margin('expanding')], [margin('stable')])).toEqual([]);
  });

  it('forecast_crosses_zero fires null to non-null and names the month', () => {
    expect(detectTransitionMilestones([forecast(2)], [forecast(null)])).toEqual([
      {
        kind: 'forecast_crosses_zero',
        label: 'Your forecast now dips below zero within 2 months.',
        statType: 'cash_forecast',
      },
    ]);
  });

  it('forecast_crosses_zero uses singular "month" when the crossing is 1 month out', () => {
    expect(detectTransitionMilestones([forecast(1)], [forecast(null)])).toEqual([
      {
        kind: 'forecast_crosses_zero',
        label: 'Your forecast now dips below zero within 1 month.',
        statType: 'cash_forecast',
      },
    ]);
  });

  it('no forecast milestone when the crossing month shifts but stays non-null', () => {
    expect(detectTransitionMilestones([forecast(3)], [forecast(1)])).toEqual([]);
  });

  it.each([
    ['cash_flow', [cashFlow('surplus')], []],
    ['break_even', [breakEven(0)], []],
    ['runway', [runway(6.0)], []],
    ['margin_trend', [margin('expanding')], []],
    ['cash_forecast', [forecast(2)], []],
  ] as const)('no milestone fires when %s is absent last week', (_statType, current, prior) => {
    expect(detectTransitionMilestones(current, prior)).toEqual([]);
  });

  it.each([
    ['cash_flow', [], [cashFlow('burning')]],
    ['break_even', [], [breakEven(500)]],
    ['runway', [], [runway(3.5)]],
    ['margin_trend', [], [margin('shrinking')]],
    ['cash_forecast', [], [forecast(null)]],
  ] as const)('no milestone fires when %s is absent this week', (_statType, current, prior) => {
    expect(detectTransitionMilestones(current, prior)).toEqual([]);
  });

  it('multiple milestones can fire in the same week', () => {
    const result = detectTransitionMilestones(
      [cashFlow('surplus'), runway(6.0)],
      [cashFlow('burning'), runway(5.5)],
    );
    expect(result).toEqual([
      { kind: 'turned_cash_positive', label: 'You turned cash-flow positive.', statType: 'cash_flow' },
      { kind: 'runway_extended_past_6mo', label: 'Your runway extended past 6 months.', statType: 'runway' },
    ]);
  });
});
