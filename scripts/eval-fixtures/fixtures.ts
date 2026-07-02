// The labeled eval set. Three hand-built financial shapes, each with an answer
// key: the stat types a faithful, complete summary has to address. These are
// authored as typed ComputedStat objects on purpose, they're the ground truth,
// not seed data reverse-engineered from CSV rows. Every `details` shape is
// cross-checked against apps/api/src/services/curation/types.ts.
//
// A note on synthetic combinations: production only emits `runway` when cash
// flow is burning (types.ts:95). `healthy-growth` pairs a long runway with a
// surplus anyway, because these fixtures exercise the pipeline + judges over
// arbitrary stat sets, not just live-shaped ones. The harness runs each set
// through real scoreInsights -> assemblePrompt, so a regression there still shows.
// The surplus (+$9k/mo) and the runway burn (-$6k/mo) are deliberately different
// magnitudes: an identical figure with a flipped sign would put a same-number
// contradiction into the faithfulness judge's ground truth and muddy the score.

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
      value: 25,
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
    {
      statType: 'runway',
      category: null,
      value: 14,
      details: {
        cashOnHand: 84000,
        monthlyNet: -6000,
        runwayMonths: 14,
        cashAsOfDate: '2026-06-01',
        confidence: 'high',
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
        cashAsOfDate: '2026-06-01',
        confidence: 'high',
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
      statType: 'break_even',
      category: null,
      value: 8000,
      details: {
        monthlyFixedCosts: 16000,
        marginPercent: 20,
        breakEvenRevenue: 48000,
        currentMonthlyRevenue: 40000,
        gap: 8000,
        confidence: 'high',
      },
    },
    {
      statType: 'cash_forecast',
      category: null,
      value: 3,
      details: {
        startingBalance: 24000,
        asOfDate: '2026-06-01',
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
      value: 11.1,
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
      value: -18,
      details: {
        slope: -150,
        intercept: 1200,
        growthPercent: -18,
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
    label: 'Expanding margin, surplus cash flow, long runway, revenue trending up',
    answerKey: ['trend', 'margin_trend', 'cash_flow', 'runway'],
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
