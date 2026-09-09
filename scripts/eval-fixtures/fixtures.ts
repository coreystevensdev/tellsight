// The labeled eval set. Three hand-built financial shapes, each with an answer
// key: the stat types a faithful, complete summary has to address. These are
// authored as typed ComputedStat objects on purpose, they're the ground truth,
// not seed data reverse-engineered from CSV rows. Every `details` shape is
// cross-checked against apps/api/src/services/curation/types.ts.
//
// A note on synthetic combinations: these exercise the pipeline and judges over
// arbitrary stat sets, not only live-shaped ones, and the harness runs each
// through the real scoreInsights -> assemblePrompt, so a regression there still
// shows.
//
// One combination has been removed rather than kept. `healthy-growth` used to
// carry a runway alongside its surplus, with the two nets given different
// magnitudes so that an identical figure with a flipped sign would not put a
// same-number contradiction into the faithfulness judge's ground truth. The
// magnitudes did not help: both stats declare trailingMonths: 6, so they describe
// the same window in opposite directions, and a summary that faithfully reports
// either one contradicts the other. The judge duly rejected "you're still
// spending more than you're earning" against a ground truth also saying
// "surplus, net +$9,000/mo".
//
// Runway is still covered, coherently, by cash-crunch. A runway is how long until
// the cash runs out, which is not a quantity a business in surplus has.

import type { ComputedStat, StatType } from '../../apps/api/src/services/curation/types.js';

export interface EvalFixture {
  id: string;
  label: string;
  // Top-K types the summary must meaningfully cover. K = answerKey.length drives
  // the completeness denominator.
  answerKey: StatType[];
  build: () => ComputedStat[];
}

export function healthyGrowth(): ComputedStat[] {
  return [
    {
      statType: 'trend',
      category: 'Revenue',
      value: 1666,
      details: {
        slope: 1666,
        intercept: 40000,
        growthPercent: 25,
        dataPoints: 6,
        firstValue: 40000,
        lastValue: 50000,
      },
    },
    {
      statType: 'margin_trend',
      category: null,
      value: 24,
      details: {
        recentMarginPercent: 24,
        priorMarginPercent: 19,
        direction: 'expanding',
        revenueGrowthPercent: 25,
        expenseGrowthPercent: 12,
      },
    },
    {
      statType: 'cash_flow',
      category: null,
      value: 9000,
      details: {
        monthlyNet: 9000,
        trailingMonths: 6,
        direction: 'surplus',
        monthsBurning: 0,
        recentMonths: [],
      },
    },
  ];
}

export function cashCrunch(): ComputedStat[] {
  return [
    {
      statType: 'runway',
      category: null,
      value: 2.4,
      details: {
        cashOnHand: 24000,
        monthlyNet: -10000,
        runwayMonths: 2.4,
        cashAsOfDate: '2026-01-01',
        confidence: 'high',
        trailingMonths: 6,
      },
    },
    {
      statType: 'cash_flow',
      category: null,
      value: -10000,
      details: {
        monthlyNet: -10000,
        trailingMonths: 6,
        direction: 'burning',
        monthsBurning: 6,
        recentMonths: [],
      },
    },
    {
      // computeBreakEven emits value: breakEvenRevenue and derives
      // breakEvenRevenue = monthlyFixedCosts / (marginPercent / 100), so 16000 at
      // 20% is 80000 and the gap against 40000 of revenue is 40000. The previous
      // numbers (48000 / gap 8000, with the gap in `value`) were not reachable by
      // any input: at a "break-even revenue" of 48000 a 20% margin returns 9600
      // against 16000 of fixed costs, which is not break-even. Faithfulness
      // scored 1.00 on it regardless, because that judge checks the summary
      // against the ground truth and never the ground truth against the formula.
      statType: 'break_even',
      category: null,
      value: 80000,
      details: {
        monthlyFixedCosts: 16000,
        marginPercent: 20,
        breakEvenRevenue: 80000,
        currentMonthlyRevenue: 40000,
        gap: 40000,
        confidence: 'high',
      },
    },
    {
      statType: 'cash_forecast',
      category: null,
      value: -3000,
      details: {
        startingBalance: 24000,
        asOfDate: '2026-01-01',
        method: 'linear_regression',
        slope: -9000,
        intercept: 24000,
        basisMonths: [],
        basisValues: [],
        projectedMonths: [
          { month: '2026-07', projectedNet: -9000, projectedBalance: 15000 },
          { month: '2026-08', projectedNet: -9000, projectedBalance: 6000 },
          { month: '2026-09', projectedNet: -9000, projectedBalance: -3000 },
        ],
        crossesZeroAtMonth: 3,
        confidence: 'high',
      },
    },
  ];
}

export function seasonalAnomaly(): ComputedStat[] {
  return [
    {
      statType: 'anomaly',
      category: 'Revenue',
      value: 28000,
      details: {
        direction: 'above',
        zScore: 2.6,
        iqrBounds: { lower: 12000, upper: 18000 },
        deviation: 11000,
      },
    },
    {
      statType: 'year_over_year',
      category: 'Revenue',
      value: 50000,
      details: {
        currentYear: 50000,
        priorYear: 45000,
        currentYearLabel: '2026',
        priorYearLabel: '2025',
        changePercent: 11.1,
        month: '2026-06',
      },
    },
    {
      statType: 'seasonal_projection',
      category: 'Revenue',
      value: 15000,
      details: {
        projectedMonth: '2026-07',
        projectedAmount: 15000,
        basisMonths: ['2025-07', '2024-07'],
        basisValues: [14200, 13900],
        confidence: 'moderate',
      },
    },
    {
      statType: 'trend',
      category: 'Marketing',
      value: -80,
      details: {
        slope: -80,
        intercept: 1200,
        growthPercent: -33.3,
        dataPoints: 6,
        firstValue: 1200,
        lastValue: 800,
      },
    },
  ];
}

export const FIXTURES: EvalFixture[] = [
  {
    id: 'healthy-growth',
    label: 'Expanding margin, surplus cash flow, revenue trending up',
    answerKey: ['trend', 'margin_trend', 'cash_flow'],
    build: healthyGrowth,
  },
  {
    id: 'cash-crunch',
    label: 'Runway under 3 months, burning cash, below break-even, forecast crosses zero',
    answerKey: ['runway', 'cash_flow', 'break_even', 'cash_forecast'],
    build: cashCrunch,
  },
  {
    // AC2 frames this as "a December revenue anomaly", but AnomalyDetails carries
    // no month field, so the calendar month isn't encodable in the stat. The label
    // describes what the data actually is: a revenue spike anomaly, not a dated one.
    id: 'seasonal-anomaly',
    label: 'Revenue spike anomaly, seasonal projection, year-over-year, category trend',
    answerKey: ['anomaly', 'year_over_year', 'seasonal_projection', 'trend'],
    build: seasonalAnomaly,
  },
];
