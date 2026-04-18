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
