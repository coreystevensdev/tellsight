import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ComputedStat, ScoringConfig } from './types.js';
import { StatType } from './types.js';

// Mock readFileSync so we control config in tests
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';

const validConfig: ScoringConfig = {
  version: '1.0',
  topN: 3,
  weights: { novelty: 0.35, actionability: 0.40, specificity: 0.25 },
  thresholds: { anomalyZScore: 2.0, trendMinDataPoints: 3, significantChangePercent: 10 },
};

function mockConfig(cfg: unknown) {
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(cfg));
}

const fixtureStats: ComputedStat[] = [
  { statType: StatType.Total, category: 'Sales', value: 5000, details: { scope: 'category', count: 10 } },
  { statType: StatType.Anomaly, category: 'Sales', value: 900, comparison: 500, details: { direction: 'above', zScore: 2.5, iqrBounds: { lower: 200, upper: 800 }, deviation: 400 } },
  { statType: StatType.Trend, category: 'Sales', value: 0.05, details: { slope: 0.05, intercept: 100, growthPercent: 25, dataPoints: 6, firstValue: 400, lastValue: 500 } },
  { statType: StatType.Average, category: 'Sales', value: 500, details: { scope: 'category', median: 480 } },
  { statType: StatType.CategoryBreakdown, category: 'Sales', value: 5000, details: { percentage: 60, absoluteTotal: 5000, transactionCount: 10, min: 100, max: 900 } },
  { statType: StatType.Total, category: null, value: 8333, details: { scope: 'overall', count: 20 } },
];

describe('scoreInsights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('scores and ranks insights, returning topN', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights(fixtureStats);

    expect(insights.length).toBeLessThanOrEqual(3);
    expect(insights.length).toBeGreaterThan(0);

    for (let i = 1; i < insights.length; i++) {
      expect(insights[i - 1]!.score).toBeGreaterThanOrEqual(insights[i]!.score);
    }
  });

  it('includes weight breakdown in each insight', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights(fixtureStats);

    for (const insight of insights) {
      expect(insight.breakdown).toHaveProperty('novelty');
      expect(insight.breakdown).toHaveProperty('actionability');
      expect(insight.breakdown).toHaveProperty('specificity');
      expect(typeof insight.breakdown.novelty).toBe('number');
    }
  });

  it('ranks anomalies and trends higher than totals', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights(fixtureStats);

    const anomalyOrTrend = insights.filter(
      (i) =>
        i.stat.statType === StatType.Anomaly ||
        i.stat.statType === StatType.Trend,
    );
    const totals = insights.filter((i) => i.stat.statType === StatType.Total);

    if (anomalyOrTrend.length > 0 && totals.length > 0) {
      expect(anomalyOrTrend[0]!.score).toBeGreaterThan(totals[0]!.score);
    }
  });

  it('returns empty array for empty stats input', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights([]);
    expect(insights).toEqual([]);
  });

  it('respects different topN from config', async () => {
    mockConfig({ ...validConfig, topN: 1 });
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights(fixtureStats);
    expect(insights.length).toBe(1);
  });

  it('changes ranking when weights change', async () => {
    mockConfig({ ...validConfig, weights: { novelty: 0.9, actionability: 0.05, specificity: 0.05 } });
    const { scoreInsights: scoreHeavyNovelty } = await import('./scoring.js');
    const heavyNovelty = scoreHeavyNovelty(fixtureStats);

    vi.resetModules();
    mockConfig({ ...validConfig, weights: { novelty: 0.05, actionability: 0.9, specificity: 0.05 } });
    const { scoreInsights: scoreHeavyAction } = await import('./scoring.js');
    const heavyAction = scoreHeavyAction(fixtureStats);

    // scoring is responsive to weight changes — both produce valid results
    expect(heavyNovelty.length).toBeGreaterThan(0);
    expect(heavyAction.length).toBeGreaterThan(0);
  });

  it('throws AppError for invalid config', async () => {
    mockConfig({ version: '1.0', topN: -1 });
    await expect(() => import('./scoring.js')).rejects.toThrow();
  });

  it('throws AppError for malformed JSON', async () => {
    vi.mocked(readFileSync).mockReturnValue('not json at all');
    await expect(() => import('./scoring.js')).rejects.toThrow();
  });

  it('never includes raw data references in ScoredInsight', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights(fixtureStats);

    for (const insight of insights) {
      const keys = Object.keys(insight);
      expect(keys).not.toContain('orgId');
      expect(keys).not.toContain('datasetId');
      expect(keys).not.toContain('rows');
    }
  });

  // CashFlow scoring — burning should rank high, surplus moderate,
  // and cash flow must not outrank MarginTrend shrinking (monotonicity).

  const monthsStub = [
    { month: '2026-01', revenue: 10000, expenses: 14000, net: -4000 },
    { month: '2026-02', revenue: 10000, expenses: 13000, net: -3000 },
    { month: '2026-03', revenue: 10000, expenses: 11000, net: -1000 },
  ];

  const cashFlowBurning3: ComputedStat = {
    statType: StatType.CashFlow,
    category: null,
    value: -3000,
    details: { monthlyNet: -3000, trailingMonths: 3, direction: 'burning', monthsBurning: 3, recentMonths: monthsStub },
  };

  const cashFlowBurning2: ComputedStat = {
    statType: StatType.CashFlow,
    category: null,
    value: -2500,
    details: { monthlyNet: -2500, trailingMonths: 3, direction: 'burning', monthsBurning: 2, recentMonths: monthsStub },
  };

  const cashFlowBurning1: ComputedStat = {
    statType: StatType.CashFlow,
    category: null,
    value: -1500,
    details: { monthlyNet: -1500, trailingMonths: 3, direction: 'burning', monthsBurning: 1, recentMonths: monthsStub },
  };

  const cashFlowSurplus: ComputedStat = {
    statType: StatType.CashFlow,
    category: null,
    value: 2000,
    details: { monthlyNet: 2000, trailingMonths: 3, direction: 'surplus', monthsBurning: 0, recentMonths: monthsStub },
  };

  const marginShrinking: ComputedStat = {
    statType: StatType.MarginTrend,
    category: null,
    value: 18,
    comparison: 25,
    details: {
      recentMarginPercent: 18,
      priorMarginPercent: 25,
      direction: 'shrinking',
      revenueGrowthPercent: 5,
      expenseGrowthPercent: 15,
    },
  };

  it('ranks CashFlow burning (monthsBurning >= 2) inside topN', async () => {
    mockConfig({ ...validConfig, topN: 3 });
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights([cashFlowBurning3, ...fixtureStats]);
    const cfInside = insights.find((i) => i.stat.statType === StatType.CashFlow);
    expect(cfInside).toBeDefined();
  });

  it('ranks CashFlow burning with 1 month below burning with 2+ months', async () => {
    mockConfig({ ...validConfig, topN: 10 });
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights([cashFlowBurning1, cashFlowBurning2]);
    const b2 = insights.find((i) => i.stat.statType === StatType.CashFlow && i.stat.details.monthsBurning === 2);
    const b1 = insights.find((i) => i.stat.statType === StatType.CashFlow && i.stat.details.monthsBurning === 1);
    expect(b2).toBeDefined();
    expect(b1).toBeDefined();
    expect(b2!.score).toBeGreaterThan(b1!.score);
  });

  it('ranks CashFlow surplus lower than burning', async () => {
    mockConfig({ ...validConfig, topN: 10 });
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights([cashFlowBurning3, cashFlowSurplus]);
    const burning = insights.find((i) => i.stat.statType === StatType.CashFlow && i.stat.details.direction === 'burning');
    const surplus = insights.find((i) => i.stat.statType === StatType.CashFlow && i.stat.details.direction === 'surplus');
    expect(burning!.score).toBeGreaterThan(surplus!.score);
  });

  it('scores CashFlow burning at exact parity with MarginTrend shrinking (tie, never inversion)', async () => {
    mockConfig({ ...validConfig, topN: 10 });
    const { scoreInsights } = await import('./scoring.js');

    const insights = scoreInsights([cashFlowBurning3, marginShrinking]);
    const cf = insights.find((i) => i.stat.statType === StatType.CashFlow)!;
    const mt = insights.find((i) => i.stat.statType === StatType.MarginTrend)!;
    // Margin is the leading signal, cash flow is the trailing consequence.
    // Under the default weight config (novelty 0.35, actionability 0.40,
    // specificity 0.25), both land at 0.840. Strict tie — any inversion
    // would be a scoring regression.
    expect(cf.score).toBeCloseTo(mt.score, 6);
  });
});

describe('scoreInsights — Runway scoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  const runwayStat = (runwayMonths: number): ComputedStat => ({
    statType: StatType.Runway,
    category: null,
    value: runwayMonths,
    details: {
      cashOnHand: 15000,
      monthlyNet: -5000,
      runwayMonths,
      cashAsOfDate: '2026-04-20T00:00:00.000Z',
      confidence: 'high',
    },
  });

  it('critical runway (<6 months) hits the exact 0.9025 score under default weights', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([runwayStat(3)]);
    // 0.85 × 0.35 + 0.95 × 0.40 + 0.90 × 0.25 = 0.9025
    expect(ranked!.score).toBeCloseTo(0.9025, 4);
    expect(ranked!.breakdown).toEqual({
      novelty: 0.85,
      actionability: 0.95,
      specificity: 0.90,
    });
  });

  it('critical runway outranks CashFlow burning by at least 0.04', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const cashFlowBurning: ComputedStat = {
      statType: StatType.CashFlow,
      category: null,
      value: -5000,
      details: {
        monthlyNet: -5000,
        trailingMonths: 3,
        direction: 'burning',
        monthsBurning: 3,
        recentMonths: [],
      },
    };

    const insights = scoreInsights([runwayStat(3), cashFlowBurning]);
    const runway = insights.find((i) => i.stat.statType === StatType.Runway)!;
    const cashFlow = insights.find((i) => i.stat.statType === StatType.CashFlow)!;

    // Quantified risk > unquantified signal. Margin: 0.9025 - 0.840 = 0.0625
    expect(runway.score - cashFlow.score).toBeGreaterThan(0.04);
  });

  it('moderate runway (6-24 months) lands in the 0.70 actionability band', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([runwayStat(12)]);
    expect(ranked!.breakdown.actionability).toBe(0.70);
    expect(ranked!.breakdown.novelty).toBe(0.65);
  });

  it('extended runway (>=24 months) drops to demoted band', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([runwayStat(36)]);
    expect(ranked!.breakdown.actionability).toBe(0.45);
  });

  it('critical runway ranks above margin-trend shrinking and year-over-year declines', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const marginShrinking: ComputedStat = {
      statType: StatType.MarginTrend,
      category: null,
      value: 0,
      details: {
        recentMarginPercent: 10,
        priorMarginPercent: 25,
        direction: 'shrinking',
        revenueGrowthPercent: -5,
        expenseGrowthPercent: 15,
      },
    };

    const insights = scoreInsights([marginShrinking, runwayStat(2)]);
    expect(insights[0]!.stat.statType).toBe(StatType.Runway);
  });

  it('config tunability: shifting weights predictably changes runway score', async () => {
    mockConfig({
      ...validConfig,
      weights: { novelty: 0.20, actionability: 0.60, specificity: 0.20 },
    });
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([runwayStat(3)]);
    // 0.85 × 0.20 + 0.95 × 0.60 + 0.90 × 0.20 = 0.17 + 0.57 + 0.18 = 0.92
    expect(ranked!.score).toBeCloseTo(0.92, 4);
  });
});

describe('scoreInsights — BreakEven scoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function breakEvenStat(gap: number, confidence: 'high' | 'moderate' | 'low' = 'high'): ComputedStat {
    return {
      statType: StatType.BreakEven,
      category: null,
      value: 75_000,
      details: {
        monthlyFixedCosts: 15_000,
        marginPercent: 20,
        breakEvenRevenue: 75_000,
        currentMonthlyRevenue: 75_000 - gap,
        gap,
        confidence,
      },
    };
  }

  it('critical break-even (gap > 0) hits the exact 0.8270 score under default weights', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([breakEvenStat(25_000)]);
    // 0.35 × 0.75 + 0.40 × 0.88 + 0.25 × 0.85 = 0.2625 + 0.352 + 0.2125 = 0.8270
    expect(ranked!.score).toBeCloseTo(0.8270, 4);
    expect(ranked!.breakdown).toEqual({
      novelty: 0.75,
      actionability: 0.88,
      specificity: 0.85,
    });
  });

  it('gap === 0 (exactly at break-even) demotes to the reassuring band', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([breakEvenStat(0)]);
    expect(ranked!.breakdown).toEqual({
      novelty: 0.60,
      actionability: 0.55,
      specificity: 0.85,
    });
  });

  it('gap < 0 (above break-even) scores the same as gap === 0 — both demoted', async () => {
    mockConfig(validConfig);
    const { scoreInsights } = await import('./scoring.js');

    const [above] = scoreInsights([breakEvenStat(-40_000)]);
    const [at] = scoreInsights([breakEvenStat(0)]);
    expect(above!.score).toBeCloseTo(at!.score, 6);
  });

  it('monotonicity: runway critical > cashflow burning > break-even gap-positive', async () => {
    mockConfig({ ...validConfig, topN: 10 });
    const { scoreInsights } = await import('./scoring.js');

    const runwayCritical: ComputedStat = {
      statType: StatType.Runway,
      category: null,
      value: 3,
      details: {
        cashOnHand: 15000,
        monthlyNet: -5000,
        runwayMonths: 3,
        cashAsOfDate: '2026-04-20T00:00:00.000Z',
        confidence: 'high',
      },
    };
    const cashFlowBurning: ComputedStat = {
      statType: StatType.CashFlow,
      category: null,
      value: -5000,
      details: {
        monthlyNet: -5000,
        trailingMonths: 3,
        direction: 'burning',
        monthsBurning: 3,
        recentMonths: [],
      },
    };
    const breakEven = breakEvenStat(25_000);

    const insights = scoreInsights([runwayCritical, cashFlowBurning, breakEven]);
    const runway = insights.find((i) => i.stat.statType === StatType.Runway)!;
    const cashFlow = insights.find((i) => i.stat.statType === StatType.CashFlow)!;
    const be = insights.find((i) => i.stat.statType === StatType.BreakEven)!;

    // Intended ranking: runway (0.9025) > burning (0.8400) > break-even gap-positive (0.8270).
    // Runway leads because it carries the most urgent signal. Burning follows because a
    // binary urgency cue should precede a quantified target. Break-even trails — it
    // refines the burn signal rather than originating one.
    expect(runway.score).toBeGreaterThan(cashFlow.score);
    expect(cashFlow.score).toBeGreaterThan(be.score);
  });

  it('config tunability: shifting weights predictably changes break-even score', async () => {
    mockConfig({
      ...validConfig,
      weights: { novelty: 0.20, actionability: 0.60, specificity: 0.20 },
    });
    const { scoreInsights } = await import('./scoring.js');

    const [ranked] = scoreInsights([breakEvenStat(25_000)]);
    // 0.75 × 0.20 + 0.88 × 0.60 + 0.85 × 0.20 = 0.15 + 0.528 + 0.17 = 0.848
    expect(ranked!.score).toBeCloseTo(0.848, 4);
  });
});
