import { describe, it, expect, vi } from 'vitest';

import type { ScoredInsight } from './types.js';
import { StatType } from './types.js';

// assemblePrompt now loads scoring.js for the sample-size gate's topN cap,
// and scoring.js imports the real logger, which imports the real config and
// throws on a test host with no .env. Mocking the logger doesn't touch the
// real on-disk template loading this file exists to exercise.
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { assemblePrompt } from './assembly.js';

// No node:fs mock here, unlike assembly.test.ts, this exercises the real
// on-disk template files through the real loadTemplate/readFileSync path.
// Catches a template edit that leaves an unresolved {{placeholder}} or
// breaks the split-file lookup, neither of which a mocked-fs test can see.

const insights: ScoredInsight[] = [
  {
    stat: {
      statType: StatType.Trend,
      category: 'Sales',
      value: 0.15,
      sampleSize: 15,
      details: { slope: 0.15, intercept: 100, growthPercent: 15, dataPoints: 6, firstValue: 400, lastValue: 460, firstPeriod: '2026-01', lastPeriod: '2026-06' },
    },
    score: 0.8,
    breakdown: { novelty: 0.8, actionability: 0.8, specificity: 0.8 },
  },
];

function assertNoUnresolvedPlaceholders(text: string, label: string) {
  const match = text.match(/\{\{\w+\}\}/);
  expect(match, `${label} still contains an unresolved placeholder: ${match?.[0]}`).toBeNull();
}

describe('v1-agent prompt template (real files)', () => {
  it('loads from disk and resolves every placeholder with insights present', () => {
    const { system, user } = assemblePrompt(insights, 1, 'v1-agent');

    assertNoUnresolvedPlaceholders(system, 'v1-agent-system.md');
    assertNoUnresolvedPlaceholders(user, 'v1-agent-user.md');
    expect(user).toContain('[cite:');
  });

  it('loads from disk and resolves every placeholder with no insights', () => {
    const { system, user } = assemblePrompt([], 1, 'v1-agent');

    assertNoUnresolvedPlaceholders(system, 'v1-agent-system.md');
    assertNoUnresolvedPlaceholders(user, 'v1-agent-user.md');
  });
});
