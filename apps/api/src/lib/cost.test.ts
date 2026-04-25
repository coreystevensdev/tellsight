import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  env: { CLAUDE_MODEL: 'claude-sonnet-4-5-20250929' },
}));

import {
  ABSOLUTE_CEILING_USD,
  CAP_MULTIPLIER,
  computeCost,
  exceedsBudget,
  medianCost,
  recordCost,
  resetHistoryForTests,
} from './cost.js';

describe('computeCost', () => {
  it('prices Sonnet 4-5 by million-token rate', () => {
    const cost = computeCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'claude-sonnet-4-5',
    );
    expect(cost).toBe(18); // 3 + 15
  });

  it('matches dated variants via prefix lookup', () => {
    const cost = computeCost(
      { input_tokens: 1000, output_tokens: 1000 },
      'claude-sonnet-4-5-20250929',
    );
    expect(cost).toBeCloseTo(0.018, 5);
  });

  it('falls back to env.CLAUDE_MODEL when model is omitted', () => {
    const cost = computeCost({ input_tokens: 1000, output_tokens: 1000 });
    expect(cost).toBeCloseTo(0.018, 5);
  });

  it('returns null for unknown model — fail-open default', () => {
    const cost = computeCost({ input_tokens: 100, output_tokens: 100 }, 'gpt-4');
    expect(cost).toBeNull();
  });

  it('Opus is 5x Sonnet at the same token volume', () => {
    const sonnet = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-sonnet-4-5');
    const opus = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-opus-4-7');
    expect(opus! / sonnet!).toBeCloseTo(5, 5);
  });
});

describe('rolling history', () => {
  beforeEach(() => resetHistoryForTests());

  it('returns null median with no history', () => {
    expect(medianCost()).toBeNull();
  });

  it('computes median over an odd-length window', () => {
    [0.01, 0.02, 0.03, 0.04, 0.05].forEach(recordCost);
    expect(medianCost()).toBe(0.03);
  });

  it('averages middle two values for even-length window', () => {
    [0.01, 0.02, 0.03, 0.04].forEach(recordCost);
    expect(medianCost()).toBeCloseTo(0.025, 5);
  });

  it('drops NaN and negative costs without polluting history', () => {
    recordCost(NaN);
    recordCost(-1);
    recordCost(0.05);
    expect(medianCost()).toBe(0.05);
  });

  it('caps history at 50 entries by evicting oldest', () => {
    for (let i = 1; i <= 60; i++) recordCost(i / 100);
    // After cap: history holds 0.11..0.60. Median is between 0.35 and 0.36.
    expect(medianCost()).toBeCloseTo(0.355, 5);
  });
});

describe('exceedsBudget', () => {
  beforeEach(() => resetHistoryForTests());

  it('trips on absolute ceiling regardless of median', () => {
    [0.01, 0.02, 0.03].forEach(recordCost);
    const result = exceedsBudget(2.0);
    expect(result.exceeded).toBe(true);
    expect(result.cap).toBe(ABSOLUTE_CEILING_USD);
  });

  it('passes within ceiling on cold start (no median yet)', () => {
    const result = exceedsBudget(0.05);
    expect(result.exceeded).toBe(false);
    expect(result.median).toBeNull();
    expect(result.cap).toBeNull();
  });

  it('trips on median multiplier anomaly once seeded', () => {
    [0.01, 0.02, 0.03].forEach(recordCost);
    const median = medianCost()!;
    const result = exceedsBudget(median * (CAP_MULTIPLIER + 1));
    expect(result.exceeded).toBe(true);
    expect(result.cap).toBeCloseTo(median * CAP_MULTIPLIER, 5);
  });

  it('passes within median multiplier', () => {
    [0.01, 0.02, 0.03].forEach(recordCost);
    const median = medianCost()!;
    const result = exceedsBudget(median * (CAP_MULTIPLIER - 1));
    expect(result.exceeded).toBe(false);
  });

  it('returns observed value in BudgetCheck for logging', () => {
    [0.01, 0.02, 0.03].forEach(recordCost);
    const result = exceedsBudget(0.04);
    expect(result.observed).toBe(0.04);
  });
});
