import { describe, it, expect } from 'vitest';
import {
  CLAUDE_PRICING,
  DEFAULT_CLAUDE_MODEL_ID,
  KNOWN_CLAUDE_MODEL_PREFIXES,
  estimateClaudeCostUsd,
  pricingForClaudeModel,
} from './index.js';

describe('estimateClaudeCostUsd', () => {
  it('computes cost against the default model (Sonnet 4.6) when no model id is passed', () => {
    // 1M input × $3/M + 1M output × $15/M = $18.00
    expect(estimateClaudeCostUsd(1_000_000, 1_000_000)).toBeCloseTo(18.0, 2);
  });

  it('handles partial millions correctly', () => {
    // 500K input × $3/M + 100K output × $15/M = $1.50 + $1.50 = $3.00
    expect(estimateClaudeCostUsd(500_000, 100_000)).toBeCloseTo(3.0, 2);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateClaudeCostUsd(0, 0)).toBe(0);
  });

  it('applies the Haiku rate card when Haiku model id is passed', () => {
    // Haiku: $1/M input, $5/M output
    // 1M × $1/M + 1M × $5/M = $6.00
    expect(estimateClaudeCostUsd(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001')).toBeCloseTo(6.0, 2);
  });

  it('applies the Opus rate card when Opus model id is passed', () => {
    // Opus: $5/M input, $25/M output
    // 100K × $5/M + 50K × $25/M = $0.50 + $1.25 = $1.75
    expect(estimateClaudeCostUsd(100_000, 50_000, 'claude-opus-4-7')).toBeCloseTo(1.75, 2);
  });

  it('pricing table is monotonic: Haiku < Sonnet < Opus for same tokens', () => {
    const h = estimateClaudeCostUsd(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001');
    const s = estimateClaudeCostUsd(1_000_000, 1_000_000, 'claude-sonnet-4-6');
    const o = estimateClaudeCostUsd(1_000_000, 1_000_000, 'claude-opus-4-7');
    expect(h).toBeLessThan(s);
    expect(s).toBeLessThan(o);
  });

  it('DEFAULT_CLAUDE_MODEL_ID resolves to an entry in CLAUDE_PRICING', () => {
    expect(CLAUDE_PRICING[DEFAULT_CLAUDE_MODEL_ID]).toBeDefined();
    expect(CLAUDE_PRICING[DEFAULT_CLAUDE_MODEL_ID].inputPerMillion).toBeGreaterThan(0);
    expect(CLAUDE_PRICING[DEFAULT_CLAUDE_MODEL_ID].outputPerMillion).toBeGreaterThan(0);
  });
});

describe('pricingForClaudeModel', () => {
  it('matches a dated model id by its prefix', () => {
    expect(pricingForClaudeModel('claude-sonnet-4-5-20250929')).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it('returns null for a model it does not know', () => {
    expect(pricingForClaudeModel('claude-sonnet-9')).toBeNull();
    expect(pricingForClaudeModel('gpt-4')).toBeNull();
    expect(pricingForClaudeModel('')).toBeNull();
  });

  it('prices Opus 4.7 at its own rate, not the retired 4.1 rate', () => {
    expect(pricingForClaudeModel('claude-opus-4-7-20260101')).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
    });
  });

  it('prices Sonnet 5 below Sonnet 4.5, per the published rates', () => {
    const five = pricingForClaudeModel('claude-sonnet-5')!;
    const fourFive = pricingForClaudeModel('claude-sonnet-4-5-20250929')!;

    expect(five).toEqual({ inputPerMillion: 2, outputPerMillion: 10 });
    expect(five.inputPerMillion).toBeLessThan(fourFive.inputPerMillion);
    expect(five.outputPerMillion).toBeLessThan(fourFive.outputPerMillion);
  });

  it('has no prefix that shadows another', () => {
    for (const a of KNOWN_CLAUDE_MODEL_PREFIXES) {
      const shadowed = KNOWN_CLAUDE_MODEL_PREFIXES.filter((b) => b !== a && b.startsWith(a));
      expect(shadowed, `${a} is a prefix of ${shadowed.join(', ')}`).toEqual([]);
    }
  });

  it('prices every entry above zero on both halves', () => {
    for (const [model, pricing] of Object.entries(CLAUDE_PRICING)) {
      expect(pricing.inputPerMillion, model).toBeGreaterThan(0);
      expect(pricing.outputPerMillion, model).toBeGreaterThan(0);
    }
  });
});
