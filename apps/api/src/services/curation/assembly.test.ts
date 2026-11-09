import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

import type { ScoredInsight, TrendStat, CategoryBreakdownStat } from './types.js';
import { StatType } from './types.js';

// assemblePrompt now loads scoring.js for the sample-size gate's topN cap,
// and scoring.js imports the real logger, which imports the real config and
// throws on a test host with no .env.
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('node:fs', () => ({
  // The assembly loader looks for split templates first (-system.md / -user.md),
  // then falls back to the single-file convention. Tests stay on the single-file
  // path by throwing ENOENT for split filenames, the legacy template content
  // below still drives every assertion.
  readFileSync: vi.fn((path: string) => {
    // assemblePrompt now loads scoring.ts's config too (topN, for the
    // filter-then-cap gate), so this mock has to answer that path with real
    // JSON or scoring.ts's module load throws before any test body runs.
    if (path.includes('scoring-weights.json')) {
      return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
    }
    if (path.includes('-system.md') || path.includes('-user.md')) {
      const err = new Error('ENOENT: no such file (test mock)') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return `Template start
{{statSummaries}}
Stat types: {{statTypeList}}
Categories: {{categoryCount}}
Insights: {{insightCount}}
Allow: {{allowedStatTypes}}
Template end`;
  }),
}));

const fixtureInsights: ScoredInsight[] = [
  {
    stat: {
      statType: StatType.Anomaly,
      category: 'Sales',
      value: 900,
      comparison: 500,
      sampleSize: 15,
      details: { direction: 'above', zScore: 2.5, iqrBounds: { lower: 200, upper: 800 }, deviation: 400, period: '2026-03' },
    },
    score: 0.85,
    breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.95 },
  },
  {
    stat: {
      statType: StatType.Trend,
      category: 'Marketing',
      value: 0.05,
      sampleSize: 15,
      details: { slope: 0.05, intercept: 100, growthPercent: 25, dataPoints: 6, firstValue: 400, lastValue: 500, firstPeriod: '2026-01', lastPeriod: '2026-06' },
    },
    score: 0.72,
    breakdown: { novelty: 0.8, actionability: 0.85, specificity: 0.7 },
  },
  {
    stat: {
      statType: StatType.Total,
      category: null,
      value: 8333,
      sampleSize: 20,
      details: { scope: 'overall', count: 20 },
    },
    score: 0.15,
    breakdown: { novelty: 0.1, actionability: 0.2, specificity: 0.2 },
  },
];

// One stat each, sampleSize overridable, everything else a plausible default.
// For the floor-gating tests below, where the stat type and sampleSize are
// what's under test and the rest of the shape is just along for the ride.
function scoredTrend(overrides: Partial<TrendStat> = {}): ScoredInsight {
  return {
    stat: {
      statType: StatType.Trend,
      category: 'Revenue',
      value: 10,
      sampleSize: 12,
      details: {
        slope: 10,
        intercept: 100,
        growthPercent: 10,
        dataPoints: 12,
        firstValue: 100,
        lastValue: 110,
        firstPeriod: '2026-01',
        lastPeriod: '2026-12',
      },
      ...overrides,
    },
    score: 0.5,
    breakdown: { novelty: 0.5, actionability: 0.5, specificity: 0.5 },
  };
}

function scoredBreakdown(overrides: Partial<CategoryBreakdownStat> = {}): ScoredInsight {
  return {
    stat: {
      statType: StatType.CategoryBreakdown,
      category: 'Revenue',
      value: 2_000,
      sampleSize: 12,
      details: { percentage: 40, absoluteTotal: 2_000, transactionCount: 12, min: 100, max: 300 },
      ...overrides,
    },
    score: 0.5,
    breakdown: { novelty: 0.5, actionability: 0.5, specificity: 0.5 },
  };
}

// The default mock for readFileSync, re-applied in beforeEach so per-test
// mockImplementation overrides don't bleed into subsequent tests.
function setDefaultFsMock(readFileSyncMock: Mock) {
  readFileSyncMock.mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.includes('scoring-weights.json')) {
      return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
    }
    if (p.includes('-system.md') || p.includes('-user.md')) {
      const err = new Error('ENOENT (test mock)') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    return `Template start
{{statSummaries}}
Stat types: {{statTypeList}}
Categories: {{categoryCount}}
Insights: {{insightCount}}
Allow: {{allowedStatTypes}}
Template end`;
  });
}

describe('assemblePrompt', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const { readFileSync } = await import('node:fs');
    setDefaultFsMock(vi.mocked(readFileSync));
  });

  it('populates template placeholders with insight data', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1);

    expect(result.user).toContain('Template start');
    expect(result.user).toContain('Template end');
    expect(result.user).toContain('[Sales] Anomaly');
    expect(result.user).toContain('[Marketing] Trend');
    expect(result.user).toContain('Stat types: anomaly, trend, total');
    expect(result.user).toContain('Categories: 2');
    expect(result.user).toContain('Insights: 3');
  });

  it('returns valid metadata with correct shape', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1);

    expect(result.metadata.statTypes).toEqual(['anomaly', 'trend', 'total']);
    expect(result.metadata.categoryCount).toBe(2);
    expect(result.metadata.insightCount).toBe(3);
    expect(result.metadata.promptVersion).toBe('v2.3');
    expect(result.metadata.generatedAt).toBeTruthy();
    expect(result.metadata.scoringWeights).toEqual({
      novelty: 0.9,
      actionability: 0.9,
      specificity: 0.95,
    });
  });

  it('handles empty insights gracefully', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([], 1);

    expect(result.user).toContain('No statistical insights available');
    expect(result.metadata.insightCount).toBe(0);
    expect(result.metadata.categoryCount).toBe(0);
    expect(result.metadata.statTypes).toEqual([]);
  });

  it('accepts a custom prompt version', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      return 'custom {{statSummaries}} {{statTypeList}} {{categoryCount}} {{insightCount}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1, 'v2');

    expect(result.metadata.promptVersion).toBe('v2');
    expect(result.user).toContain('custom');
  });

  it('injects stat-ID allowlist with alphabetized order', async () => {
    const { readFileSync } = await import('node:fs');
    // Force single-file fallback so the test's tiny override template is the
    // entire prompt, split-file mode would compose system + user instead.
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Allow: {{allowedStatTypes}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1, 'v2');

    // fixture has anomaly, trend, total in relevance order; allowlist sorts alphabetically
    expect(result.user).toBe('Allow: anomaly, total, trend');
  });

  it('renders allowlist as "none" when insights are empty', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Allow: {{allowedStatTypes}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([], 1, 'v2');

    expect(result.user).toBe('Allow: none');
  });

  // This asserted the prompt did not contain "orgId", "datasetId" or "rows",
  // none of which a ScoredInsight has ever carried, so it could not fail.
  // Appending JSON.stringify(insights) to the prompt still passed it. The
  // privacy boundary is real, but it is the ComputedStat union in types.ts that
  // enforces it, and the test contributed nothing while reading as if it did.
  //
  // What can actually regress is the rendering: assembly walks each insight and
  // formats named fields, so anything that serialises an object wholesale, or
  // widens the formatter to dump unknown keys, leaks internals into the prompt.
  it('renders formatted stats only, never the insight objects themselves', async () => {
    const { assemblePrompt } = await import('./assembly.js');

    // Values chosen to be unmistakable in a diff and impossible to produce by
    // formatting. score and breakdown are ranking signals the model never sees.
    const sentinel: ScoredInsight[] = [
      {
        stat: {
          statType: StatType.Anomaly,
          category: 'Sales',
          value: 900,
          comparison: 500,
          sampleSize: 15,
          details: { direction: 'above', zScore: 2.5, iqrBounds: { lower: 200, upper: 800 }, deviation: 400, period: '2026-03' },
        },
        score: 0.123456789,
        breakdown: { novelty: 0.987654321, actionability: 0.876543219, specificity: 0.765432198 },
      },
    ];

    const prompt = assemblePrompt(sentinel, 1).user;

    // Positive control first: without this the rest passes on an empty prompt.
    expect(prompt).toContain('Sales');
    expect(prompt).toContain('z-score: 2.50');
    // Anomalies are the only stat the model can place in time, and only via
    // this. Dropping it is how two spikes months apart read as one event.
    expect(prompt).toContain('Anomaly (2026-03)');

    for (const internal of ['0.123456789', '0.987654321', '0.876543219', '0.765432198']) {
      expect(prompt, `scoring internal ${internal} reached the prompt`).not.toContain(internal);
    }

    // Object syntax at all means something was serialised rather than formatted.
    expect(prompt).not.toContain('{"');
    expect(prompt).not.toContain('"statType"');
    expect(prompt).not.toContain('"breakdown"');
    expect(prompt).not.toContain('iqrBounds');
  });

  it('formats each stat type correctly in the prompt', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1);

    // anomaly
    expect(result.user).toContain('z-score: 2.50');
    expect(result.user).toContain('above normal');
    // trend
    expect(result.user).toContain('up 25.0%');
    expect(result.user).toContain('6 months');
    // The window itself, not just its length. Without it the model cannot tell
    // whether a trend overlaps a dated stat, which is what made every
    // "revenue held up while marketing fell" sentence unverifiable.
    expect(result.user).toContain('Trend (2026-01 to 2026-06)');
    // total
    expect(result.user).toContain('[Overall] Total');
    expect(result.user).toContain('20 transactions');
  });

  it('deduplicates stat types in metadata', async () => {
    const duplicateInsights: ScoredInsight[] = [
      { ...fixtureInsights[0]! },
      {
        stat: {
          statType: StatType.Anomaly,
          category: 'Marketing',
          value: 100,
          comparison: 500,
          sampleSize: 15,
          details: { direction: 'below', zScore: -3, iqrBounds: { lower: 200, upper: 800 }, deviation: -400, period: '2026-03' },
        },
        score: 0.8,
        breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.7 },
      },
    ];

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(duplicateInsights, 1);

    expect(result.metadata.statTypes).toEqual(['anomaly']);
  });

  it('formats CashForecast with crossesZeroAtMonth inline and arrow-chained balances', async () => {
    const forecastInsight: ScoredInsight = {
      stat: {
        statType: StatType.CashForecast,
        category: null,
        value: -5_000,
        sampleSize: 15,
        details: {
          startingBalance: 58_000,
          asOfDate: '2026-06-01T00:00:00.000Z',
          method: 'linear_regression',
          slope: -17_000,
          intercept: 0,
          basisMonths: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
          basisValues: [-15000, -16000, -17000, -18000, -19000, -20000],
          projectedMonths: [
            { month: '2026-07', projectedNet: -17_000, projectedBalance: 41_000 },
            { month: '2026-08', projectedNet: -18_000, projectedBalance: 23_000 },
            { month: '2026-09', projectedNet: -18_000, projectedBalance: 5_000 },
          ],
          crossesZeroAtMonth: null,
          confidence: 'high',
        },
      },
      score: 0.88,
      breakdown: { novelty: 0.85, actionability: 0.92, specificity: 0.85 },
    };

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([forecastInsight], 1);

    expect(result.user).toContain('Cash Forecast: balance $58,000 → $41,000 → $23,000 → $5,000');
    expect(result.user).toContain('method: linear_regression');
    expect(result.user).toContain('confidence: high');
  });

  it('CashForecast with crossesZeroAtMonth !== null appends the crossing phrase', async () => {
    const forecastInsight: ScoredInsight = {
      stat: {
        statType: StatType.CashForecast,
        category: null,
        value: -12_000,
        sampleSize: 15,
        details: {
          startingBalance: 25_000,
          asOfDate: '2026-06-01T00:00:00.000Z',
          method: 'linear_regression',
          slope: 0,
          intercept: -10_000,
          basisMonths: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'],
          basisValues: [-10000, -10000, -10000, -10000, -10000, -10000],
          projectedMonths: [
            { month: '2026-07', projectedNet: -10_000, projectedBalance: 15_000 },
            { month: '2026-08', projectedNet: -10_000, projectedBalance: 5_000 },
            { month: '2026-09', projectedNet: -10_000, projectedBalance: -5_000 },
          ],
          crossesZeroAtMonth: 3,
          confidence: 'high',
        },
      },
      score: 0.88,
      breakdown: { novelty: 0.85, actionability: 0.92, specificity: 0.85 },
    };

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([forecastInsight], 1);

    expect(result.user).toContain('→ -$5,000');
    expect(result.user).toContain('balance crosses zero around month 3');
  });

  it('defaults to v2.3 prompt version', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([fixtureInsights[0]!], 1);
    expect(result.metadata.promptVersion).toBe('v2.3');
  });

  it('interpolates a passed priorContext into {{priorContext}}', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Context: {{priorContext}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1, 'v2-digest', null, new Date(), 'Last week: cash flow held steady.');

    expect(result.user).toBe('Context: Last week: cash flow held steady.');
  });

  it('defaults priorContext to "" when the 5th argument is omitted, without breaking template renders', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Context: [{{priorContext}}]';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1);

    expect(result.user).toBe('Context: []');
  });

  it('interpolates priorContext on the empty-insights branch too', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Context: {{priorContext}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([], 1, 'v2-digest', null, new Date(), 'Last week: no data yet.');

    expect(result.user).toBe('Context: Last week: no data yet.');
  });

  it('appends a [cite: <id>] suffix to each stat line matching statInstanceId', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const { statInstanceId } = await import('./computation.js');
    const result = assemblePrompt(fixtureInsights, 1);

    for (const insight of fixtureInsights) {
      expect(result.user).toContain(`[cite: ${statInstanceId(insight.stat, 1)}]`);
    }
  });

  it('gives two same-type stats in different categories distinct cite ids', async () => {
    const twoTotals: ScoredInsight[] = [
      {
        stat: { statType: StatType.Total, category: 'Food', value: 400_000, sampleSize: 10, details: { scope: 'category', count: 10 } },
        score: 0.5,
        breakdown: { novelty: 0.5, actionability: 0.5, specificity: 0.5 },
      },
      {
        stat: { statType: StatType.Total, category: 'Drinks', value: 229_000, sampleSize: 8, details: { scope: 'category', count: 8 } },
        score: 0.4,
        breakdown: { novelty: 0.4, actionability: 0.4, specificity: 0.4 },
      },
    ];

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(twoTotals, 1);

    const ids = [...result.user.matchAll(/\[cite: ([^\]]+)\]/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('throws CONFIG_ERROR naming an unknown placeholder still left in the template', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Allow: {{allowedStatIds}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const { AppError } = await import('../../lib/appError.js');

    try {
      assemblePrompt(fixtureInsights, 1, 'v2');
      expect.unreachable('assemblePrompt should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as InstanceType<typeof AppError>;
      expect(appErr.code).toBe('CONFIG_ERROR');
      expect(appErr.statusCode).toBe(500);
      expect(appErr.message).toContain('{{allowedStatIds}}');
    }
  });

  it('throws CONFIG_ERROR naming both unknown placeholders, deduped, when two are present', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'A: {{oldTokenOne}} B: {{oldTokenTwo}} again: {{oldTokenOne}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const { AppError } = await import('../../lib/appError.js');

    try {
      assemblePrompt(fixtureInsights, 1, 'v2');
      expect.unreachable('assemblePrompt should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as InstanceType<typeof AppError>;
      expect(appErr.code).toBe('CONFIG_ERROR');
      expect(appErr.statusCode).toBe(500);
      expect(appErr.message).toContain('{{oldTokenOne}}');
      expect(appErr.message).toContain('{{oldTokenTwo}}');
      // deduped: the repeated {{oldTokenOne}} shows up once, not twice
      expect(appErr.message.split('{{oldTokenOne}}')).toHaveLength(2);
    }
  });

  it('does not throw when a substituted value (not the template) contains {{...}}-shaped text', async () => {
    const brokenCategoryInsights: ScoredInsight[] = [
      {
        stat: {
          statType: StatType.Total,
          category: '{{fake}}',
          value: 500,
          sampleSize: 3,
          details: { scope: 'category', count: 3 },
        },
        score: 0.5,
        breakdown: { novelty: 0.5, actionability: 0.5, specificity: 0.5 },
      },
    ];

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(brokenCategoryInsights, 1);

    // the CSV-sourced category leaks its literal braces into statSummaries,
    // but the raw template itself had every placeholder valid, so this must not throw
    expect(result.user).toContain('[{{fake}}] Total');
  });

  it('throws only on the stale token when a template mixes it with otherwise-valid known placeholders', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Today: {{today}} Allow: {{allowedStatIds}} Count: {{insightCount}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const { AppError } = await import('../../lib/appError.js');

    try {
      assemblePrompt(fixtureInsights, 1, 'v2');
      expect.unreachable('assemblePrompt should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as InstanceType<typeof AppError>;
      expect(appErr.message).toBe('Prompt template contains unknown placeholder(s): {{allowedStatIds}}');
    }
  });

  it('substitutes every occurrence of a placeholder repeated in the same template', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Header: {{today}} ... Footer: {{today}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const fixedNow = new Date('2026-03-05T12:00:00.000Z');
    const result = assemblePrompt(fixtureInsights, 1, 'v2', null, fixedNow);

    expect(result.user).toBe('Header: Thursday, March 5, 2026 ... Footer: Thursday, March 5, 2026');
  });

  // Both instants are March 5 in UTC. The first is March 4 anywhere west, the
  // second March 6 anywhere east, so there is no timezone in which local
  // formatting passes both. Noon UTC, which this file used to pin, is the one
  // hour of the day where almost every zone agrees and so proves nothing.
  it.each([
    ['02:30', '2026-03-05T02:30:00.000Z'],
    ['22:30', '2026-03-05T22:30:00.000Z'],
  ])('renders {{today}} in UTC for an instant at %s, whatever the host zone', async (_label, iso) => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('scoring-weights.json')) {
        return '{"version":"1.0","topN":8,"weights":{"novelty":0.35,"actionability":0.4,"specificity":0.25},"thresholds":{"anomalyZScore":2,"trendMinDataPoints":3,"significantChangePercent":10}}';
      }
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return '{{today}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 1, 'v2', null, new Date(iso));

    expect(result.user).toBe('Thursday, March 5, 2026');
    expect(result.metadata.generatedAt.slice(0, 10)).toBe('2026-03-05');
  });

  describe('sample-size floor', () => {
    it('omits a below-floor stat from the rendered prompt', async () => {
      const { assemblePrompt } = await import('./assembly.js');
      const thin = scoredTrend({ sampleSize: 3, category: 'Marketing' });
      const thick = scoredTrend({ sampleSize: 12, category: 'Revenue' });

      const { user, metadata } = assemblePrompt([thin, thick], 1);

      expect(user).toContain('Revenue');
      expect(user).not.toContain('Marketing');
      expect(metadata.suppressedForSampleSize).toBe(1);
    });

    // Pins the fix: a below-floor stat ranked ahead of thicker ones must not
    // cost the prompt a slot a thicker stat earned. Two below-floor stats
    // rank first here, ten above-floor ones follow -- more than topN (8) on
    // their own. Slicing to topN before filtering (the old order) would take
    // the first 8 (2 thin + 6 thick), filter the 2 thin out, and land on 6
    // survivors with two wasted slots instead of the 8 available.
    it('fills topN from survivors instead of slicing before the floor filter', async () => {
      const { assemblePrompt } = await import('./assembly.js');

      const belowFloor = ['BelowA', 'BelowB'].map((category) =>
        scoredTrend({ sampleSize: 3, category }),
      );
      const aboveFloor = Array.from({ length: 10 }, (_, i) =>
        scoredTrend({ sampleSize: 12, category: `Above${i}` }),
      );

      const { user, metadata } = assemblePrompt([...belowFloor, ...aboveFloor], 1);

      expect(metadata.insightCount).toBe(8);
      expect(metadata.suppressedForSampleSize).toBe(2);
      expect(user).not.toContain('BelowA');
      expect(user).not.toContain('BelowB');
      for (let i = 0; i < 8; i++) {
        expect(user).toContain(`Above${i}`);
      }
      expect(user).not.toContain('Above8');
      expect(user).not.toContain('Above9');
    });

    // Pins the default so a future caller that doesn't know isPreselected
    // exists still gets gated, same case as the first test but with the
    // 7th argument omitted instead of left implicit.
    it('gates by default when isPreselected is not passed', async () => {
      const { assemblePrompt } = await import('./assembly.js');
      const thin = scoredTrend({ sampleSize: 3 });

      const { metadata } = assemblePrompt([thin], 1);

      expect(metadata.suppressedForSampleSize).toBe(1);
      expect(metadata.statTypes).toEqual([]);
    });

    // The alert path: a deterministic rule already examined this exact stat
    // and found it over a threshold, so the floor should not override that.
    it('does not suppress a below-floor stat when isPreselected is true', async () => {
      const { assemblePrompt } = await import('./assembly.js');
      const thin = scoredTrend({ sampleSize: 3, category: 'Marketing' });

      const { user, metadata } = assemblePrompt([thin], 1, undefined, undefined, new Date(), '', true);

      expect(user).toContain('Marketing');
      expect(user).not.toContain('No statistical insights available');
      expect(metadata.statTypes).toEqual(['trend']);
      expect(metadata.suppressedForSampleSize).toBe(0);
    });

    it('still assembles when every stat is below its floor', async () => {
      const { assemblePrompt } = await import('./assembly.js');

      const { user, metadata } = assemblePrompt([scoredTrend({ sampleSize: 2 })], 1);

      expect(metadata.suppressedForSampleSize).toBe(1);
      expect(user.length).toBeGreaterThan(0);
      expect(metadata.statTypes).toEqual([]);
    });

    it('drops a suppressed stat type from metadata, so no question is suggested about it', async () => {
      const { assemblePrompt } = await import('./assembly.js');

      const { metadata } = assemblePrompt(
        [scoredTrend({ sampleSize: 2 }), scoredBreakdown({ sampleSize: 12 })],
        1,
      );

      expect(metadata.statTypes).toEqual(['category_breakdown']);
    });

    it('counts zero suppressed when every stat clears its floor', async () => {
      const { assemblePrompt } = await import('./assembly.js');

      const { metadata } = assemblePrompt([scoredTrend({ sampleSize: 12 })], 1);

      expect(metadata.suppressedForSampleSize).toBe(0);
    });

    // transparencyMetadataSchema.parse runs against this exact shape at the
    // digest and alert cache-miss call sites. A required field here would
    // reject every ai_summaries row written before this field existed.
    it('parses a stored metadata object that predates this field, defaulting it to 0', async () => {
      const { transparencyMetadataSchema } = await import('./types.js');

      const storedBeforeThisField = {
        statTypes: ['trend', 'total'],
        categoryCount: 2,
        insightCount: 3,
        scoringWeights: { novelty: 0.4, actionability: 0.4, specificity: 0.2 },
        promptVersion: 'v2.3',
        generatedAt: '2026-10-01T00:00:00.000Z',
      };

      const parsed = transparencyMetadataSchema.parse(storedBeforeThisField);

      expect(parsed.suppressedForSampleSize).toBe(0);
    });
  });
});

describe('assemblePrompt, cash flow monthly series', () => {
  // The whole v2.3 renderer could be deleted with 3,088 api tests and 171 eval
  // tests still green, and the seed prompt byte-identical, because the seed
  // produces no cash_flow stat at all. The v2.3 assertions that existed all
  // checked metadata.promptVersion, which is the label rather than the content.
  // sampleSize is separable from the series only because the eval fixtures once
  // carried a monthlyNet of 9000 beside `recentMonths: []`, which is the shape
  // the empty-series branch below exists for.
  const cashFlow = (
    months: { month: string; revenue: number; expenses: number; net: number }[],
    sampleSize = months.length,
  ): ScoredInsight => ({
    stat: {
      statType: StatType.CashFlow,
      category: null,
      value: 7000,
      sampleSize,
      details: {
        monthlyNet: 7000,
        trailingMonths: months.length,
        direction: 'surplus',
        monthsBurning: months.filter((m) => m.net < 0).length,
        recentMonths: months,
      },
    },
    score: 0.9,
    breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.9 },
  });

  const threeMonths = [
    { month: '2026-04', revenue: 40000, expenses: 33000, net: 7000 },
    { month: '2026-05', revenue: 44000, expenses: 36000, net: 8000 },
    { month: '2026-06', revenue: 48000, expenses: 39000, net: 9000 },
  ];

  it('renders every month with all three figures at the default version', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const { user, metadata } = assemblePrompt([cashFlow(threeMonths)], 1);

    expect(metadata.promptVersion).toBe('v2.3');
    expect(user).toContain('by month');
    for (const m of threeMonths) {
      expect(user, `${m.month} must carry revenue, expenses and net`).toContain(
        `${m.month} rev $${m.revenue.toLocaleString('en-US')} exp $${m.expenses.toLocaleString('en-US')} net +$${m.net.toLocaleString('en-US')}`,
      );
    }
  });

  it('renders a negative month with the sign, not as a magnitude', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    // cash_flow's sample-size floor is 3 (sampleSizeFloors.ts:45), so a
    // one-month fixture is suppressed before it reaches a renderer.
    const burning = [
      { month: '2026-04', revenue: 40000, expenses: 50000, net: -10000 },
      { month: '2026-05', revenue: 41000, expenses: 44000, net: -3000 },
      { month: '2026-06', revenue: 42000, expenses: 40000, net: 2000 },
    ];
    const { user } = assemblePrompt([cashFlow(burning)], 1);

    expect(user).toContain('2026-04 rev $40,000 exp $50,000 net -$10,000');
    expect(user).toContain('2026-06 rev $42,000 exp $40,000 net +$2,000');
  });

  it('omits the series on a version outside the gate', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    // v2.2 rendered revenue alone and was deleted for measuring worse. An older
    // arm has to produce the prompt it originally produced, so the gate is a
    // version set rather than an unconditional append.
    const { user } = assemblePrompt([cashFlow(threeMonths)], 1, 'v2.1');

    expect(user).not.toContain('by month');
    expect(user).toContain('Cash Flow: surplus');
  });

  it('omits the series when the producer emitted no months', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const { user } = assemblePrompt([cashFlow([], 3)], 1);

    expect(user).not.toContain('by month');
    expect(user).toContain('Cash Flow: surplus');
  });
});

describe('assemblePrompt, the renderers nothing was pinning', () => {
  // A mutation sweep over all 13 stat renderers, corrupting each label and
  // running every test file that reaches assemblePrompt, found 6 that nothing
  // observed: these. DW-249 had guessed 10 from the seed snapshot's blind list,
  // which answers "what does the seed produce", a different question.
  const insight = (stat: ScoredInsight['stat'], score = 0.9): ScoredInsight => ({
    stat,
    score,
    breakdown: { novelty: score, actionability: score, specificity: score },
  });

  async function render(stat: ScoredInsight['stat']): Promise<string> {
    const { assemblePrompt } = await import('./assembly.js');
    return assemblePrompt([insight(stat)], 1).user;
  }

  it('average renders value and median to the cent', async () => {
    // signedCents, not usd: usd is maximumFractionDigits 0, which silently
    // turned $181.82 into $182 when DW-246 first routed this through usdMinus.
    const user = await render({
      statType: StatType.Average,
      category: 'Office Supplies',
      value: 181.818,
      sampleSize: 11,
      details: { scope: 'category', median: 500 },
    });
    expect(user).toContain('[Office Supplies] Average: $181.82, median: $500.00');
  });

  it('average keeps the sign outside the symbol when a credit nets it negative', async () => {
    const user = await render({
      statType: StatType.Average,
      category: 'Office Supplies',
      value: -181.818,
      sampleSize: 11,
      details: { scope: 'category', median: -500 },
    });
    expect(user).toContain('Average: -$181.82, median: -$500.00');
  });

  it('breakdown renders the range with " to ", not a hyphen', async () => {
    // $500-$3000 becomes $-3000-$500 once a bound can be negative, which is
    // why the separator changed with DW-246.
    const user = await render({
      statType: StatType.CategoryBreakdown,
      category: 'Office Supplies',
      value: 2000,
      sampleSize: 11,
      details: { percentage: 100, absoluteTotal: 8000, transactionCount: 11, min: -3000, max: 500 },
    });
    expect(user).toContain(
      '[Office Supplies] Breakdown: 100.0% of total ($8,000, 11 transactions, range: -$3000 to $500',
    );
  });

  it('year-over-year names both years rather than just the delta', async () => {
    const user = await render({
      statType: StatType.YearOverYear,
      category: 'Revenue',
      value: 12000,
      sampleSize: 2,
      details: {
        currentRevenue: 50000,
        priorRevenue: 38000,
        currentYearLabel: '2026',
        priorYearLabel: '2025',
        changePercent: 31.58,
        month: '2026-03',
      },
    });
    expect(user).toContain(
      '[Revenue] Year-over-Year (2026-03): $50,000 in 2026 vs $38,000 in 2025 (+31.6%',
    );
  });

  it('margin trend signs both growth figures', async () => {
    // Expenses falling while revenue rises is the case where an unsigned
    // expense figure reads as the opposite of what happened.
    const user = await render({
      statType: StatType.MarginTrend,
      category: null,
      value: 17.1,
      sampleSize: 6,
      details: {
        // Off the .x5 rounding boundary on purpose: 10.95.toFixed(1) is "10.9",
        // because 10.95 is not exactly representable. That is real behavior and
        // not what this test is about.
        recentMarginPercent: 28.1,
        priorMarginPercent: 11.04,
        direction: 'expanding',
        revenueGrowthPercent: 37.0,
        expenseGrowthPercent: -10.6,
      },
    });
    expect(user).toContain(
      '[Overall] Margin Trend: expanding, recent 28.1% vs prior 11.0% (revenue +37.0%, expenses -10.6%',
    );
  });

  it('seasonal projection names the basis months it was built from', async () => {
    // basisMonths is the same calendar month across years, not a consecutive
    // series (revenueMetrics.ts loops years for one fixed month). Pinned with
    // two different years so a future consecutive-series reading fails here.
    const user = await render({
      statType: StatType.SeasonalProjection,
      category: 'Revenue',
      value: 46000,
      sampleSize: 2,
      details: {
        projectedMonth: '2026-07',
        projectedAmount: 46000,
        basisMonths: ['2025-07', '2024-07'],
        basisValues: [44000, 48000],
        confidence: 'moderate',
      },
    });
    expect(user).toContain(
      '[Revenue] Seasonal Projection: 2026-07 estimated at $46,000 based on 2025-07, 2024-07 (confidence: moderate',
    );
  });

  it('plan vs actual says over, under or on plan, and never a bare percentage', async () => {
    const over = await render({
      statType: StatType.CategoryVariance,
      category: 'Marketing',
      value: 105,
      sampleSize: 6,
      details: {
        plannedMonthly: 500,
        actualMonthly: 605,
        variance: 105,
        variancePercent: 21,
        monthLabel: '2026-10',
        direction: 'over',
      },
    });
    expect(over).toContain(
      '[Marketing] Plan vs actual (2026-10): planned $500, spent $605, over plan by 21.0%',
    );
  });

  it('plan vs actual reads "on plan" for the on_plan direction', async () => {
    // direction is a three-way union and the renderer maps it through a nested
    // ternary, so the third branch is the one a two-case test would miss.
    const user = await render({
      statType: StatType.CategoryVariance,
      category: 'Marketing',
      value: 0,
      sampleSize: 6,
      details: {
        plannedMonthly: 500,
        actualMonthly: 500,
        variance: 0,
        variancePercent: 0,
        monthLabel: '2026-10',
        direction: 'on_plan',
      },
    });
    expect(user).toContain('spent $500, on plan by 0.0%');
  });
});

describe('assemblePrompt, trend percentages that are not percentages', () => {
  const trend = (firstValue: number, lastValue: number): ScoredInsight => ({
    stat: {
      statType: StatType.Trend,
      category: 'Office Supplies',
      value: lastValue,
      sampleSize: 11,
      details: {
        slope: (lastValue - firstValue) / 9,
        intercept: firstValue,
        growthPercent: firstValue !== 0 ? ((lastValue - firstValue) / Math.abs(firstValue)) * 100 : 0,
        dataPoints: 10,
        firstValue,
        lastValue,
        firstPeriod: '2026-01',
        lastPeriod: '2026-10',
      },
    },
    score: 0.79,
    breakdown: { novelty: 0.8, actionability: 0.8, specificity: 0.8 },
  });

  async function render(insight: ScoredInsight): Promise<string> {
    const { assemblePrompt } = await import('./assembly.js');
    return assemblePrompt([insight], 1).user;
  }

  it('omits the percentage when the endpoints straddle zero', async () => {
    // (-2500 - 500) / 500 is -600%, and "down 600.0%" is not a thing spending
    // can do: it cannot fall more than 100% and still be spending.
    const user = await render(trend(500, -2500));

    expect(user).toContain(
      '[Office Supplies] Trend (2026-01 to 2026-10): $500 -> -$2500 over 10 months, down across zero so no percentage applies',
    );
    expect(user).not.toContain('600.0%');
    expect(user).not.toContain('%,');
  });

  it('omits it in the other direction too, a credit year turning into spending', async () => {
    const user = await render(trend(-2500, 500));

    expect(user).toContain('-$2500 -> $500 over 10 months, up across zero so no percentage applies');
    expect(user).not.toContain('120.0%');
  });

  it('omits it when the base is zero, where the producer reports 0% regardless', async () => {
    // growthPercent is 0 by statisticalAnalysis.ts's own guard, so the old
    // renderer said "up 0.0%" for a category that fell $2,500.
    const user = await render(trend(0, -2500));

    expect(user).toContain('$0 -> -$2500 over 10 months, down from zero so no percentage applies');
    expect(user).not.toContain('0.0%');
  });

  it('still reports a real -100% when the trend ends at zero', async () => {
    // $600 to $0 is a well-defined fall of 100%, not a sign change, so this is
    // the boundary the fix must not swallow.
    const user = await render(trend(600, 0));

    expect(user).toContain(
      '[Office Supplies] Trend (2026-01 to 2026-10): down 100.0% over 10 months ($600 -> $0',
    );
  });

  it('leaves an ordinary same-sign trend exactly as it was', async () => {
    const user = await render(trend(600, 400));

    expect(user).toContain(
      '[Office Supplies] Trend (2026-01 to 2026-10): down 33.3% over 10 months ($600 -> $400',
    );
  });
});
