import { describe, it, expect } from 'vitest';

import type {
  ComputedStat,
  CashFlowDetails,
  MarginTrendDetails,
} from '../../services/curation/types.js';
import { classifyValence } from './valence.js';

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

// The seven stat types the classifier ignores. Listed so AC2 can be exercised
// across the whole set, not just one representative.
type NonFinancialType =
  | 'total'
  | 'average'
  | 'trend'
  | 'anomaly'
  | 'category_breakdown'
  | 'year_over_year'
  | 'seasonal_projection';

// A non-financial stat: carries no valence signal regardless of which type it is.
function nonFinancial(kind: NonFinancialType): ComputedStat {
  switch (kind) {
    case 'total':
      return { statType: 'total', category: 'revenue', value: 50000, details: { scope: 'all', count: 120 } };
    case 'average':
      return { statType: 'average', category: 'revenue', value: 417, details: { scope: 'all', median: 400 } };
    case 'trend':
      return {
        statType: 'trend',
        category: 'revenue',
        value: 12,
        details: { slope: 1666, intercept: 40000, growthPercent: 25, dataPoints: 6, firstValue: 40000, lastValue: 50000 },
      };
    case 'anomaly':
      return {
        statType: 'anomaly',
        category: 'expenses',
        value: 9000,
        details: { direction: 'above', zScore: 2.4, iqrBounds: { lower: 3000, upper: 7000 }, deviation: 4000 },
      };
    case 'category_breakdown':
      return {
        statType: 'category_breakdown',
        category: 'payroll',
        value: 30000,
        details: { percentage: 60, absoluteTotal: 30000, transactionCount: 12, min: 2000, max: 4000 },
      };
    case 'year_over_year':
      return {
        statType: 'year_over_year',
        category: 'revenue',
        value: 10,
        details: {
          currentYear: 50000,
          priorYear: 45000,
          currentYearLabel: '2026',
          priorYearLabel: '2025',
          changePercent: 10,
          month: '2026-06',
        },
      };
    case 'seasonal_projection':
      return {
        statType: 'seasonal_projection',
        category: 'revenue',
        value: 52000,
        details: { projectedMonth: '2026-07', projectedAmount: 52000, basisMonths: [], basisValues: [], confidence: 'high' },
      };
  }
}

function total(): ComputedStat {
  return nonFinancial('total');
}

describe('classifyValence', () => {
  it('returns neutral for an empty array (AC1)', () => {
    expect(classifyValence([])).toBe('neutral');
  });

  it.each([
    'total',
    'average',
    'trend',
    'anomaly',
    'category_breakdown',
    'year_over_year',
    'seasonal_projection',
  ] as const)('returns neutral when only non-financial stat %s is present (AC2)', (kind) => {
    expect(classifyValence([nonFinancial(kind)])).toBe('neutral');
  });

  it('returns neutral for a mix of every non-financial stat type (AC2)', () => {
    const everyNonFinancial: ComputedStat[] = [
      'total',
      'average',
      'trend',
      'anomaly',
      'category_breakdown',
      'year_over_year',
      'seasonal_projection',
    ].map((k) => nonFinancial(k as NonFinancialType));
    expect(classifyValence(everyNonFinancial)).toBe('neutral');
  });

  it.each([
    ['runway 2.9 alone', [runway(2.9)], 'concerning'],
    ['runway < 3 with surplus cash flow', [runway(1.5), cashFlow('surplus')], 'concerning'],
    ['runway < 3 with expanding margin', [runway(2), margin('expanding')], 'concerning'],
    ['runway < 3 with healthy forecast', [runway(0.5), forecast(null)], 'concerning'],
    [
      'runway < 3 buried among positives',
      [total(), margin('expanding'), runway(2.5), forecast(null), breakEven(-5000)],
      'concerning',
    ],
  ] as const)('hard runway override → concerning: %s (AC3)', (_, stats, expected) => {
    expect(classifyValence(stats)).toBe(expected);
  });

  it.each([
    ['burning cash flow, no runway', [cashFlow('burning')], 'watching'],
    ['burning cash flow with non-financial noise', [total(), cashFlow('burning')], 'watching'],
  ] as const)('absence semantics → watching not concerning: %s (AC4)', (_, stats, expected) => {
    expect(classifyValence(stats)).toBe(expected);
  });

  it.each([
    ['runway 6 alone', [runway(6)], 'positive'],
    ['runway 9 alone', [runway(9)], 'positive'],
    ['runway 6 with surplus cash flow', [runway(6), cashFlow('surplus')], 'positive'],
  ] as const)('positive runway → positive: %s (AC5)', (_, stats, expected) => {
    expect(classifyValence(stats)).toBe(expected);
  });

  it.each([
    ['shrinking margin', [runway(9), margin('shrinking')], 'watching'],
    ['burning cash flow', [runway(9), cashFlow('burning')], 'watching'],
    ['break-even gap above zero', [runway(9), breakEven(4000)], 'watching'],
    ['forecast crosses zero', [runway(9), forecast(2)], 'watching'],
  ] as const)(
    'positive runway dominated by co-present negative (%s) → watching (AC5 priority)',
    (_, stats, expected) => {
      expect(classifyValence(stats)).toBe(expected);
    },
  );

  it.each([
    [2.9, 'concerning'],
    [3.0, 'watching'],
    [5.9, 'watching'],
    [6.0, 'positive'],
  ] as const)('runway boundary %d → %s (AC6)', (months, expected) => {
    expect(classifyValence([runway(months)])).toBe(expected);
  });

  it('runway 3.0 with surplus cash flow stays watching, not positive (AC6 mixed)', () => {
    expect(classifyValence([runway(3.0), cashFlow('surplus')])).toBe('watching');
  });

  it.each([
    ['surplus cash flow', [cashFlow('surplus')], 'positive'],
    ['expanding margin', [margin('expanding')], 'positive'],
    ['forecast never crosses zero', [forecast(null)], 'positive'],
    ['break-even gap at or below zero', [breakEven(0)], 'positive'],
    ['negative break-even gap', [breakEven(-3000)], 'positive'],
  ] as const)('positive signals → positive: %s (AC7)', (_, stats, expected) => {
    expect(classifyValence(stats)).toBe(expected);
  });

  it.each([
    ['shrinking margin', [margin('shrinking')], 'watching'],
    ['break-even gap above zero', [breakEven(4000)], 'watching'],
    ['forecast crosses zero', [forecast(2)], 'watching'],
    ['runway in 3-6 band', [runway(4)], 'watching'],
    ['shrinking margin overrides surplus cash flow', [margin('shrinking'), cashFlow('surplus')], 'watching'],
  ] as const)('watching signals → watching: %s (AC8)', (_, stats, expected) => {
    expect(classifyValence(stats)).toBe(expected);
  });

  it('stable margin alone falls through to neutral', () => {
    expect(classifyValence([margin('stable')])).toBe('neutral');
  });

  it('concerning has exactly one path, no non-runway signal alone produces it', () => {
    const nonRunwayNegatives: ComputedStat[][] = [
      [cashFlow('burning')],
      [margin('shrinking')],
      [breakEven(4000)],
      [forecast(2)],
      [cashFlow('burning'), margin('shrinking'), breakEven(4000), forecast(2)],
    ];
    for (const stats of nonRunwayNegatives) {
      expect(classifyValence(stats)).not.toBe('concerning');
    }
  });
});
