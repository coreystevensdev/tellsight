import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  env: { CLAUDE_MODEL: 'claude-sonnet-4-6' },
}));

import {
  ABSOLUTE_CEILING_USD,
  ADAPT_AFTER_CONSECUTIVE_REFUSALS,
  CAP_MULTIPLIER,
  computeCost,
  exceedsBudget,
  medianCost,
  recordCost,
  recordRefusedCost,
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

  it('returns null for unknown model, fail-open default', () => {
    const cost = computeCost({ input_tokens: 100, output_tokens: 100 }, 'gpt-4');
    expect(cost).toBeNull();
  });

  // Was 'Opus is 5x Sonnet', asserting the 15/75 the table carried for Opus 4.7.
  // That is Opus 4.1's retired price; 4.7 is 5/25, so the real ratio is 5/3. The
  // test named the wrong number as confidently as the table held it, which is how
  // it survived: both halves agreed with each other and neither with Anthropic.
  it('Opus costs 5/3 of Sonnet at the same token volume', () => {
    const sonnet = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-sonnet-4-5');
    const opus = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-opus-4-7');
    expect(opus! / sonnet!).toBeCloseTo(5 / 3, 5);
  });

  // The reason to look at Sonnet 5 at all, before quality: it is cheaper per
  // token on both halves. Nominally 33%, though Claude 4.7 and later use a
  // tokenizer that emits about 30% more tokens for the same text, so the real
  // saving is nearer 13% and no per-token comparison across that line is honest.
  it('Sonnet 5 costs less per token than Sonnet 4.5', () => {
    const five = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-sonnet-5');
    const fourFive = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'claude-sonnet-4-5');
    expect(five!).toBeLessThan(fourFive!);
  });
});

describe('rolling history', () => {
  beforeEach(() => resetHistoryForTests());

  it('returns null median with no history', () => {
    expect(medianCost('claude-sonnet-4-6')).toBeNull();
  });

  it('computes median over an odd-length window', () => {
    [0.01, 0.02, 0.03, 0.04, 0.05].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    expect(medianCost('claude-sonnet-4-6')).toBe(0.03);
  });

  it('averages middle two values for even-length window', () => {
    [0.01, 0.02, 0.03, 0.04].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    expect(medianCost('claude-sonnet-4-6')).toBeCloseTo(0.025, 5);
  });

  it('drops NaN and negative costs without polluting history', () => {
    recordCost(NaN, 'claude-sonnet-4-6');
    recordCost(-1, 'claude-sonnet-4-6');
    recordCost(0.05, 'claude-sonnet-4-6');
    expect(medianCost('claude-sonnet-4-6')).toBe(0.05);
  });

  it('caps history at 50 entries by evicting oldest', () => {
    for (let i = 1; i <= 60; i++) recordCost(i / 100, 'claude-sonnet-4-6');
    // After cap: history holds 0.11..0.60. Median is between 0.35 and 0.36.
    expect(medianCost('claude-sonnet-4-6')).toBeCloseTo(0.355, 5);
  });
});

describe('exceedsBudget', () => {
  beforeEach(() => resetHistoryForTests());

  it('trips on absolute ceiling regardless of median', () => {
    [0.01, 0.02, 0.03].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    const result = exceedsBudget(2.0, 'claude-sonnet-4-6');
    expect(result.exceeded).toBe(true);
    expect(result.cap).toBe(ABSOLUTE_CEILING_USD);
  });

  it('passes within ceiling on cold start (no median yet)', () => {
    const result = exceedsBudget(0.05, 'claude-sonnet-4-6');
    expect(result.exceeded).toBe(false);
    expect(result.median).toBeNull();
    expect(result.cap).toBeNull();
  });

  it('trips on median multiplier anomaly once seeded', () => {
    [0.01, 0.02, 0.03].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    const median = medianCost('claude-sonnet-4-6')!;
    const result = exceedsBudget(median * (CAP_MULTIPLIER + 1), 'claude-sonnet-4-6');
    expect(result.exceeded).toBe(true);
    expect(result.cap).toBeCloseTo(median * CAP_MULTIPLIER, 5);
  });

  it('passes within median multiplier', () => {
    [0.01, 0.02, 0.03].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    const median = medianCost('claude-sonnet-4-6')!;
    const result = exceedsBudget(median * (CAP_MULTIPLIER - 1), 'claude-sonnet-4-6');
    expect(result.exceeded).toBe(false);
  });

  it('returns observed value in BudgetCheck for logging', () => {
    [0.01, 0.02, 0.03].forEach((c) => recordCost(c, 'claude-sonnet-4-6'));
    const result = exceedsBudget(0.04, 'claude-sonnet-4-6');
    expect(result.observed).toBe(0.04);
  });
});

describe('recordRefusedCost', () => {
  beforeEach(resetHistoryForTests);

  const seed = (value: number, times = 5) => {
    for (let i = 0; i < times; i++) recordCost(value, 'claude-sonnet-4-6');
  };

  it('keeps a single refusal out of history so one anomaly cannot move the floor', () => {
    seed(0.01);
    expect(recordRefusedCost(0.5, 'claude-sonnet-4-6')).toBe(false);
    expect(medianCost('claude-sonnet-4-6')).toBe(0.01);
  });

  it('does not recalibrate before the threshold', () => {
    seed(0.01);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS - 1; i++) {
      expect(recordRefusedCost(0.05, 'claude-sonnet-4-6')).toBe(false);
    }
    expect(medianCost('claude-sonnet-4-6')).toBe(0.01);
  });

  it('clears the window on the threshold-th consecutive refusal', () => {
    seed(0.01);
    let recalibrated = false;
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS; i++) {
      recalibrated = recordRefusedCost(0.05, 'claude-sonnet-4-6');
    }
    expect(recalibrated).toBe(true);
    expect(medianCost('claude-sonnet-4-6')).toBeNull();
  });

  it('a passing call resets the run, so scattered refusals never recalibrate', () => {
    seed(0.01);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS - 1; i++) {
        expect(recordRefusedCost(0.05, 'claude-sonnet-4-6')).toBe(false);
      }
      recordCost(0.01, 'claude-sonnet-4-6');
    }
    expect(medianCost('claude-sonnet-4-6')).toBe(0.01);
  });

  it('once recalibrated, the next call is bounded only by the absolute ceiling', () => {
    seed(0.01);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS; i++) recordRefusedCost(0.05, 'claude-sonnet-4-6');
    // What the old floor refused outright now passes and reseeds the window.
    expect(exceedsBudget(0.05, 'claude-sonnet-4-6').exceeded).toBe(false);
  });

  it('still refuses above the absolute ceiling after recalibrating', () => {
    seed(0.01);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS; i++) recordRefusedCost(0.05, 'claude-sonnet-4-6');
    expect(exceedsBudget(ABSOLUTE_CEILING_USD + 1, 'claude-sonnet-4-6').exceeded).toBe(true);
  });

  it('ignores NaN and negative costs without advancing the run', () => {
    seed(0.01);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS * 2; i++) {
      expect(recordRefusedCost(Number.NaN, 'claude-sonnet-4-6')).toBe(false);
      expect(recordRefusedCost(-1, 'claude-sonnet-4-6')).toBe(false);
    }
    expect(medianCost('claude-sonnet-4-6')).toBe(0.01);
  });
});

describe('per-model windows', () => {
  beforeEach(resetHistoryForTests);

  const SUBJECT = 'claude-sonnet-4-6';
  const JUDGE = 'claude-opus-5';

  it('a cheap model does not drag down a dearer model\'s floor', () => {
    // The 2026-11-03 eval shape: a cheap subject and a dear judge in one
    // process. Shared history refused 37 of ~300 judge calls, none anomalous.
    for (let i = 0; i < 20; i++) recordCost(0.005, SUBJECT);
    expect(exceedsBudget(0.03, JUDGE).exceeded).toBe(false);
    expect(exceedsBudget(0.03, SUBJECT).exceeded).toBe(true);
  });

  it('keeps each model on its own median', () => {
    for (let i = 0; i < 10; i++) recordCost(0.005, SUBJECT);
    for (let i = 0; i < 10; i++) recordCost(0.03, JUDGE);
    expect(medianCost(SUBJECT)).toBeCloseTo(0.005, 6);
    expect(medianCost(JUDGE)).toBeCloseTo(0.03, 6);
  });

  it('an unseeded model is a cold start, not a breach of someone else floor', () => {
    for (let i = 0; i < 20; i++) recordCost(0.005, SUBJECT);
    expect(medianCost(JUDGE)).toBeNull();
    expect(exceedsBudget(0.5, JUDGE)).toMatchObject({ exceeded: false, cap: null });
  });

  it('recalibrating one model leaves the other alone', () => {
    for (let i = 0; i < 10; i++) recordCost(0.005, SUBJECT);
    for (let i = 0; i < 10; i++) recordCost(0.03, JUDGE);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS; i++) recordRefusedCost(0.2, JUDGE);
    expect(medianCost(JUDGE)).toBeNull();
    expect(medianCost(SUBJECT)).toBeCloseTo(0.005, 6);
  });

  it('a passing call on one model does not reset the other run', () => {
    for (let i = 0; i < 10; i++) recordCost(0.03, JUDGE);
    for (let i = 0; i < ADAPT_AFTER_CONSECUTIVE_REFUSALS - 1; i++) {
      expect(recordRefusedCost(0.2, JUDGE)).toBe(false);
      recordCost(0.005, SUBJECT);
    }
    // The interleaving that defeated the shared counter: with per-model runs
    // the judge's streak survives the subject's passes.
    expect(recordRefusedCost(0.2, JUDGE)).toBe(true);
  });
});
