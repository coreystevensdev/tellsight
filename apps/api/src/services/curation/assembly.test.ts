import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ScoredInsight } from './types.js';
import { StatType } from './types.js';

vi.mock('node:fs', () => ({
  // The assembly loader looks for split templates first (-system.md / -user.md),
  // then falls back to the single-file convention. Tests stay on the single-file
  // path by throwing ENOENT for split filenames — the legacy template content
  // below still drives every assertion.
  readFileSync: vi.fn((path: string) => {
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
Allow: {{allowedStatIds}}
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
      details: { direction: 'above', zScore: 2.5, iqrBounds: { lower: 200, upper: 800 }, deviation: 400 },
    },
    score: 0.85,
    breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.95 },
  },
  {
    stat: {
      statType: StatType.Trend,
      category: 'Marketing',
      value: 0.05,
      details: { slope: 0.05, intercept: 100, growthPercent: 25, dataPoints: 6, firstValue: 400, lastValue: 500 },
    },
    score: 0.72,
    breakdown: { novelty: 0.8, actionability: 0.85, specificity: 0.7 },
  },
  {
    stat: {
      statType: StatType.Total,
      category: null,
      value: 8333,
      details: { scope: 'overall', count: 20 },
    },
    score: 0.15,
    breakdown: { novelty: 0.1, actionability: 0.2, specificity: 0.2 },
  },
];

// The default mock for readFileSync — re-applied in beforeEach so per-test
// mockImplementation overrides don't bleed into subsequent tests.
function setDefaultFsMock(readFileSyncMock: ReturnType<typeof vi.fn>) {
  readFileSyncMock.mockImplementation((path: unknown) => {
    const p = String(path);
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
Allow: {{allowedStatIds}}
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
    const result = assemblePrompt(fixtureInsights);

    expect(result.prompt).toContain('Template start');
    expect(result.prompt).toContain('Template end');
    expect(result.prompt).toContain('[Sales] Anomaly');
    expect(result.prompt).toContain('[Marketing] Trend');
    expect(result.prompt).toContain('Stat types: anomaly, trend, total');
    expect(result.prompt).toContain('Categories: 2');
    expect(result.prompt).toContain('Insights: 3');
  });

  it('returns valid metadata with correct shape', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights);

    expect(result.metadata.statTypes).toEqual(['anomaly', 'trend', 'total']);
    expect(result.metadata.categoryCount).toBe(2);
    expect(result.metadata.insightCount).toBe(3);
    expect(result.metadata.promptVersion).toBe('v1.6');
    expect(result.metadata.generatedAt).toBeTruthy();
    expect(result.metadata.scoringWeights).toEqual({
      novelty: 0.9,
      actionability: 0.9,
      specificity: 0.95,
    });
  });

  it('handles empty insights gracefully', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([]);

    expect(result.prompt).toContain('No statistical insights available');
    expect(result.metadata.insightCount).toBe(0);
    expect(result.metadata.categoryCount).toBe(0);
    expect(result.metadata.statTypes).toEqual([]);
  });

  it('accepts a custom prompt version', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue('custom {{statSummaries}} {{statTypeList}} {{categoryCount}} {{insightCount}}');

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 'v2');

    expect(result.metadata.promptVersion).toBe('v2');
    expect(result.prompt).toContain('custom');
  });

  it('injects stat-ID allowlist with alphabetized order', async () => {
    const { readFileSync } = await import('node:fs');
    // Force single-file fallback so the test's tiny override template is the
    // entire prompt — split-file mode would compose system + user instead.
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Allow: {{allowedStatIds}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights, 'v2');

    // fixture has anomaly, trend, total in relevance order; allowlist sorts alphabetically
    expect(result.prompt).toBe('Allow: anomaly, total, trend');
  });

  it('renders allowlist as "none" when insights are empty', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes('-system.md') || p.includes('-user.md')) {
        const err = new Error('ENOENT (test mock)') as Error & { code: string };
        err.code = 'ENOENT';
        throw err;
      }
      return 'Allow: {{allowedStatIds}}';
    });

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([], 'v2');

    expect(result.prompt).toBe('Allow: none');
  });

  it('never includes raw data fields in the prompt', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights);

    // only check the prompt text — the metadata property is part of AssembledContext, not a data leak
    const prompt = result.prompt;
    expect(prompt).not.toContain('"orgId"');
    expect(prompt).not.toContain('"datasetId"');
    expect(prompt).not.toContain('"rows"');
  });

  it('formats each stat type correctly in the prompt', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(fixtureInsights);

    // anomaly
    expect(result.prompt).toContain('z-score: 2.50');
    expect(result.prompt).toContain('above normal');
    // trend
    expect(result.prompt).toContain('up 25.0%');
    expect(result.prompt).toContain('6 periods');
    // total
    expect(result.prompt).toContain('[Overall] Total');
    expect(result.prompt).toContain('20 transactions');
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
          details: { direction: 'below', zScore: -3, iqrBounds: { lower: 200, upper: 800 }, deviation: -400 },
        },
        score: 0.8,
        breakdown: { novelty: 0.9, actionability: 0.9, specificity: 0.7 },
      },
    ];

    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt(duplicateInsights);

    expect(result.metadata.statTypes).toEqual(['anomaly']);
  });

  it('formats CashForecast with crossesZeroAtMonth inline and arrow-chained balances', async () => {
    const forecastInsight: ScoredInsight = {
      stat: {
        statType: StatType.CashForecast,
        category: null,
        value: -5_000,
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
    const result = assemblePrompt([forecastInsight]);

    expect(result.prompt).toContain('Cash Forecast: balance $58,000 → $41,000 → $23,000 → $5,000');
    expect(result.prompt).toContain('method: linear_regression');
    expect(result.prompt).toContain('confidence: high');
  });

  it('CashForecast with crossesZeroAtMonth !== null appends the crossing phrase', async () => {
    const forecastInsight: ScoredInsight = {
      stat: {
        statType: StatType.CashForecast,
        category: null,
        value: -12_000,
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
    const result = assemblePrompt([forecastInsight]);

    expect(result.prompt).toContain('→ -$5,000');
    expect(result.prompt).toContain('balance crosses zero around month 3');
  });

  it('defaults to v1.6 prompt version', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([fixtureInsights[0]!]);
    expect(result.metadata.promptVersion).toBe('v1.6');
  });
});
