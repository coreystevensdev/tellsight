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

// The clock the eval hands the model. It lives here rather than in
// eval-summaries.ts because the fixture dates below only mean anything relative
// to it, and the guard that checks them has to read the same value.
export const FROZEN_NOW = new Date('2026-01-15T12:00:00Z');

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
      // Mirrors dataPoints below: computeTrends sets sampleSize from the same
      // monthly count (statisticalAnalysis.ts:52), so the two can never differ.
      sampleSize: 6,
      details: {
        slope: 1666,
        intercept: 40000,
        growthPercent: 25,
        dataPoints: 6,
        firstValue: 40000,
        lastValue: 50000,
        firstPeriod: '2025-07',
        lastPeriod: '2025-12',
      },
    },
    {
      statType: 'margin_trend',
      category: null,
      value: 24,
      // The thinner of the recent/prior windows (marginMetrics.ts:86). Eight
      // months a side, real history behind the comparison, not the bare floor.
      sampleSize: 8,
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
      sampleSize: 6,
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
      sampleSize: 6,
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
      sampleSize: 6,
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
      // Inherits margin_trend's sampleSize outright (financialMetrics.ts:161),
      // same floor and same real-margin reasoning as healthyGrowth's.
      sampleSize: 8,
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
      // netsFromBuckets defaults to a 12-month basis window
      // (cashFlowMetrics.ts:132), a year of history behind the regression.
      sampleSize: 12,
      details: {
        startingBalance: 24000,
        asOfDate: '2026-01-01',
        method: 'linear_regression',
        slope: -9000,
        intercept: 24000,
        // 12 months, matching sampleSize's length. Doesn't reach the
        // prompt (formatStatBody's CashForecast case, assembly.ts:117, never
        // reads these) or the citable set (validator.ts excludes slope and
        // intercept on purpose), so populating them is score-neutral.
        // Regression on these 12 values gives slope -1465/intercept 2474,
        // not the stated -9000/24000: a pre-existing gap, deferred rather
        // than fixed here, alongside hasValidDiscriminatorFields's missing
        // CashForecast case, the reason this went unnoticed in the first
        // place.
        basisMonths: [
          '2025-01',
          '2025-02',
          '2025-03',
          '2025-04',
          '2025-05',
          '2025-06',
          '2025-07',
          '2025-08',
          '2025-09',
          '2025-10',
          '2025-11',
          '2025-12',
        ],
        basisValues: [
          3000, 1500, 0, -2000, -4000, -5500, -7000, -8500, -9500, -10500, -11500, -13000,
        ],
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
      // The category baseline the IQR fence is built on, every Revenue row
      // across the window (statisticalAnalysis.ts:127), not just the one
      // flagged December transaction.
      sampleSize: 20,
      details: {
        direction: 'above',
        zScore: 2.6,
        iqrBounds: { lower: 12000, upper: 18000 },
        deviation: 11000,
        period: '2025-12',
      },
    },
    {
      statType: 'year_over_year',
      category: 'Revenue',
      value: 16000,
      // Null by construction: this compares two monthly totals, not a count
      // (revenueMetrics.ts:51), so there's no single n to report.
      sampleSize: null,
      details: {
        // 50000 against 45000 was three times the 12000-18000 range the anomaly
        // stat declares normal for this business, on a month five months after
        // the date the prompt gives as today. Both wrong, and the second one
        // corrupted the only temporal frame the model gets.
        currentRevenue: 16000,
        priorRevenue: 14400,
        currentYearLabel: '2025',
        priorYearLabel: '2024',
        changePercent: 11.1,
        // 'Nov', not '2025-11'. computeYearOverYear writes MONTH_NAMES[month],
        // so production emits an abbreviation and hasValidDiscriminatorFields
        // rejects anything else. The year is carried by currentYearLabel, which
        // the stat line renders alongside it.
        month: 'Nov',
      },
    },
    {
      statType: 'seasonal_projection',
      category: 'Revenue',
      value: 15000,
      // Matches basisValues.length below, same count computeSeasonalProjection
      // assigns to both (revenueMetrics.ts:114): two basis Julys.
      sampleSize: 2,
      details: {
        projectedMonth: '2026-07',
        projectedAmount: 15000,
        basisMonths: ['2025-07', '2024-07'],
        basisValues: [14200, 13900],
        confidence: 'moderate',
      },
    },
    {
      // The comparison the model kept reaching for and could not make. Marketing
      // falls over exactly this window, so "revenue held up while marketing fell"
      // is now checkable instead of unsupportable. lastValue is the same 16000
      // the year-over-year stat reports for 2025-11, so the two agree rather
      // than describing different businesses.
      statType: 'trend',
      category: 'Revenue',
      value: 600,
      sampleSize: 6,
      details: {
        slope: 600,
        intercept: 13000,
        growthPercent: 23.1,
        dataPoints: 6,
        firstValue: 13000,
        lastValue: 16000,
        firstPeriod: '2025-06',
        lastPeriod: '2025-11',
      },
    },
    {
      statType: 'trend',
      category: 'Marketing',
      value: -80,
      sampleSize: 6,
      details: {
        slope: -80,
        intercept: 1200,
        growthPercent: -33.3,
        dataPoints: 6,
        firstValue: 1200,
        lastValue: 800,
        firstPeriod: '2025-06',
        lastPeriod: '2025-11',
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
    // AC2 framed this as "a December revenue anomaly" and the month used to be
    // unencodable, so the label dropped it. AnomalyDetails.period carries it now.
    id: 'seasonal-anomaly',
    label: 'December revenue spike anomaly, seasonal projection, year-over-year, category trend',
    answerKey: ['anomaly', 'year_over_year', 'seasonal_projection', 'trend'],
    build: seasonalAnomaly,
  },
];
