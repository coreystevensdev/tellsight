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
        // This was `[]`, which buildCashFlowStat cannot emit: it builds
        // recentMonths from the bucket window and derives monthlyNet,
        // monthsBurning and direction from it, returning no stat at all if any
        // month has zero revenue (cashFlowMetrics.ts:52-69). So the four fields
        // above were claims with nothing behind them.
        //
        // Revenue tracks the trend stat's endpoints, 40000 at 2025-07 to 50000
        // at 2025-12, because those two are rendered into the prompt and a
        // series disagreeing with them would hand the model a contradiction.
        // Nets are chosen so their median is exactly 9000.
        //
        // What is not cross-checked, deliberately: expenses grow 15.2% here
        // against margin_trend's 12%, and the opening margin is 17.5% against
        // its priorMarginPercent of 19. margin_trend measures eight months a
        // side and this window is six, so they describe different periods and
        // forcing them to agree would invent a coherence the producer does not
        // guarantee. The end margin does land on 24%, matching
        // recentMarginPercent, which is a happy accident rather than a
        // constraint.
        //
        // None of this reaches the prompt: assembly.ts:102 renders direction,
        // monthlyNet, trailingMonths and monthsBurning only. This is a fixture
        // repair in the DW-234 sense, not a fix for DW-243's score.
        recentMonths: [
          { month: '2025-07', revenue: 40000, expenses: 33000, net: 7000 },
          { month: '2025-08', revenue: 42000, expenses: 34000, net: 8000 },
          { month: '2025-09', revenue: 44000, expenses: 35200, net: 8800 },
          { month: '2025-10', revenue: 46000, expenses: 36800, net: 9200 },
          { month: '2025-11', revenue: 48000, expenses: 37500, net: 10500 },
          { month: '2025-12', revenue: 50000, expenses: 38000, net: 12000 },
        ],
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
        // Was `[]`, same impossible shape as healthy-growth's: buildCashFlowStat
        // derives the four fields above from this series and cannot emit it
        // empty. Nets median to exactly -10000, all six are negative to match
        // monthsBurning, and the last month's revenue is break_even's rendered
        // currentMonthlyRevenue of 40000. 24000 / 10000 also reproduces the
        // runway stat's 2.4 months.
        //
        // Known and left alone: cash_forecast's basisValues for 2025-07 to
        // 2025-12 are -3000 to -8000, which median to -5500 rather than the
        // -10000 here, so the two stats disagree about the same six months.
        // Neither basisValues nor this series reaches the prompt, and the
        // alternative was changing monthlyNet, which feeds runway's 2.4 and
        // would contradict this fixture's own label. Filed as its own entry
        // rather than redesigned here.
        recentMonths: [
          { month: '2025-07', revenue: 44000, expenses: 51000, net: -7000 },
          { month: '2025-08', revenue: 43000, expenses: 51000, net: -8000 },
          { month: '2025-09', revenue: 42000, expenses: 51500, net: -9500 },
          { month: '2025-10', revenue: 41000, expenses: 51500, net: -10500 },
          { month: '2025-11', revenue: 40000, expenses: 52000, net: -12000 },
          { month: '2025-12', revenue: 40000, expenses: 53000, net: -13000 },
        ],
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
      // the last projectedBalance, which is what computeCashForecast returns
      value: -6000,
      // netsFromBuckets defaults to a 12-month basis window
      // (cashFlowMetrics.ts:132), a year of history behind the regression.
      sampleSize: 12,
      details: {
        startingBalance: 24000,
        asOfDate: '2026-01-01',
        method: 'linear_regression',
        // DW-234: these were -9000 and 24000, which no regression over the
        // basis produced. The values below are exactly linear, so
        // linearRegression returns -1000 and 3000 exactly rather than to a
        // tolerance, and fixture-arithmetic.test.ts now re-derives every
        // number here from them.
        slope: -1000,
        intercept: 3000,
        // 12 months, matching sampleSize's length.
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
        basisValues: [3000, 2000, 1000, 0, -1000, -2000, -3000, -4000, -5000, -6000, -7000, -8000],
        // nextMonthKey('2025-12', 1..3), which the old values missed by six
        // months. projectedNet is round(slope * t + intercept) at t = 12, 13,
        // 14, so the burn accelerates, which is what a negative slope means.
        // The old fixture held it flat at -9000 while claiming that slope.
        projectedMonths: [
          { month: '2026-01', projectedNet: -9000, projectedBalance: 15000 },
          { month: '2026-02', projectedNet: -10000, projectedBalance: 5000 },
          { month: '2026-03', projectedNet: -11000, projectedBalance: -6000 },
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
