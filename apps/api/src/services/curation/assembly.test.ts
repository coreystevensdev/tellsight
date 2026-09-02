import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ScoredInsight } from './types.js';
import { StatType } from './types.js';

vi.mock('node:fs', () => ({
  // The assembly loader looks for split templates first (-system.md / -user.md),
  // then falls back to the single-file convention. Tests stay on the single-file
  // path by throwing ENOENT for split filenames, the legacy template content
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

// The default mock for readFileSync, re-applied in beforeEach so per-test
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
    const result = assemblePrompt([], 1);

    expect(result.user).toContain('No statistical insights available');
    expect(result.metadata.insightCount).toBe(0);
    expect(result.metadata.categoryCount).toBe(0);
    expect(result.metadata.statTypes).toEqual([]);
  });

  it('accepts a custom prompt version', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue('custom {{statSummaries}} {{statTypeList}} {{categoryCount}} {{insightCount}}');

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
          details: { direction: 'above', zScore: 2.5, iqrBounds: { lower: 200, upper: 800 }, deviation: 400 },
        },
        score: 0.123456789,
        breakdown: { novelty: 0.987654321, actionability: 0.876543219, specificity: 0.765432198 },
      },
    ];

    const prompt = assemblePrompt(sentinel, 1).user;

    // Positive control first: without this the rest passes on an empty prompt.
    expect(prompt).toContain('Sales');
    expect(prompt).toContain('z-score: 2.50');

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
    expect(result.user).toContain('6 periods');
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
          details: { direction: 'below', zScore: -3, iqrBounds: { lower: 200, upper: 800 }, deviation: -400 },
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

  it('defaults to v1.6 prompt version', async () => {
    const { assemblePrompt } = await import('./assembly.js');
    const result = assemblePrompt([fixtureInsights[0]!], 1);
    expect(result.metadata.promptVersion).toBe('v1.6');
  });

  it('interpolates a passed priorContext into {{priorContext}}', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
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
        stat: { statType: StatType.Total, category: 'Food', value: 400_000, details: { scope: 'category', count: 10 } },
        score: 0.5,
        breakdown: { novelty: 0.5, actionability: 0.5, specificity: 0.5 },
      },
      {
        stat: { statType: StatType.Total, category: 'Drinks', value: 229_000, details: { scope: 'category', count: 8 } },
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
});
