import { describe, it, expect } from 'vitest';

import type { ComputedStat, ScoredInsight } from '../curation/types.js';
import { StatType } from '../curation/types.js';
import { getChartKindForPool, getChartKindForRuleKind } from './chartKind.js';

describe('getChartKindForRuleKind', () => {
  it('maps runway_runs_short to runway', () => {
    expect(getChartKindForRuleKind('runway_runs_short')).toBe('runway');
  });

  it('maps cash_burn_spikes to cash-flow', () => {
    expect(getChartKindForRuleKind('cash_burn_spikes')).toBe('cash-flow');
  });

  it('maps margin_drops to margin', () => {
    expect(getChartKindForRuleKind('margin_drops')).toBe('margin');
  });

  it('has no chart for breakeven_gap_widens', () => {
    expect(getChartKindForRuleKind('breakeven_gap_widens')).toBeNull();
  });

  it('has no chart for anomaly_fires', () => {
    expect(getChartKindForRuleKind('anomaly_fires')).toBeNull();
  });
});

describe('getChartKindForPool', () => {
  function scored(stat: ComputedStat, score: number): ScoredInsight {
    return { stat, score, breakdown: { novelty: 0, actionability: 0, specificity: 0 } };
  }

  const runway: ComputedStat = {
    statType: StatType.Runway,
    category: null,
    value: 4,
    sampleSize: 3,
    details: {
      cashOnHand: 10_000,
      monthlyNet: -2_500,
      runwayMonths: 4,
      cashAsOfDate: '2026-11-01',
      confidence: 'high',
      trailingMonths: 3,
    },
  };

  const cashFlow: ComputedStat = {
    statType: StatType.CashFlow,
    category: null,
    value: -2_500,
    sampleSize: 4,
    details: {
      monthlyNet: -2_500,
      trailingMonths: 4,
      direction: 'burning',
      monthsBurning: 3,
      recentMonths: [{ month: '2026-10', revenue: 40_000, expenses: 42_500, net: -2_500 }],
    },
  };

  const margin: ComputedStat = {
    statType: StatType.MarginTrend,
    category: null,
    value: 12,
    sampleSize: 6,
    details: {
      recentMarginPercent: 12,
      priorMarginPercent: 22,
      direction: 'shrinking',
      revenueGrowthPercent: -4,
      expenseGrowthPercent: 6,
    },
  };

  const anomaly: ComputedStat = {
    statType: StatType.Anomaly,
    category: 'Payroll',
    value: 9_000,
    sampleSize: 12,
    details: {
      direction: 'above',
      zScore: 3.1,
      iqrBounds: { lower: 1_000, upper: 5_000 },
      deviation: 4_000,
      period: '2026-10',
    },
  };

  it('picks the highest scoring chartable kind', () => {
    expect(
      getChartKindForPool([scored(margin, 0.52), scored(runway, 0.90), scored(cashFlow, 0.74)]),
    ).toBe('runway');
  });

  it('returns null when nothing in the pool is chartable', () => {
    expect(getChartKindForPool([scored(anomaly, 0.95)])).toBeNull();
  });

  it('returns null for an empty pool', () => {
    expect(getChartKindForPool([])).toBeNull();
  });

  // A stat can outrank every chartable one and still have no chart. Anomaly
  // scores 0.9 novelty, higher than anything runway reaches, so taking the
  // pool's top entry and mapping it would return null on a week that had a
  // perfectly good cash-flow chart available.
  it('ignores a higher scoring stat that has no chart', () => {
    expect(getChartKindForPool([scored(anomaly, 0.95), scored(cashFlow, 0.74)])).toBe('cash-flow');
  });

  // The one exact tie in the reachable score lattice: cash-flow burning for two
  // or more months and margin shrinking both land on 0.8400 under weights
  // 0.35/0.40/0.25. rankInsights has no tiebreak, so a stable sort would decide
  // this by computation emission order.
  it('breaks the 0.84 cash-flow against margin tie toward cash-flow', () => {
    expect(getChartKindForPool([scored(margin, 0.84), scored(cashFlow, 0.84)])).toBe('cash-flow');
  });

  // CAP-2's determinism criterion. Reversing the input must not move the answer,
  // which is exactly what an implementation that sorted and took [0] would fail.
  it('returns the same kind whichever order the tied stats arrive in', () => {
    const a = getChartKindForPool([scored(margin, 0.84), scored(cashFlow, 0.84)]);
    const b = getChartKindForPool([scored(cashFlow, 0.84), scored(margin, 0.84)]);
    expect(a).toBe(b);
  });

  it('prefers runway when it ties with cash-flow', () => {
    expect(getChartKindForPool([scored(cashFlow, 0.84), scored(runway, 0.84)])).toBe('runway');
  });
});
