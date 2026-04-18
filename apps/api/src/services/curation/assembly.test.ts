import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ScoredInsight } from './types.js';
import { StatType } from './types.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => `Template start
{{statSummaries}}
Stat types: {{statTypeList}}
Categories: {{categoryCount}}
Insights: {{insightCount}}
Template end`),
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

describe('assemblePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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
    expect(result.metadata.promptVersion).toBe('v1.1');
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
});
