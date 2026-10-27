import { describe, it, expect } from 'vitest';
import { CLAUDE_PRICING, DEFAULT_CLAUDE_MODEL_ID, estimateClaudeCostUsd } from './index.js';

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
    // Opus: $15/M input, $75/M output
    // 100K × $15/M + 50K × $75/M = $1.50 + $3.75 = $5.25
    expect(estimateClaudeCostUsd(100_000, 50_000, 'claude-opus-4-7')).toBeCloseTo(5.25, 2);
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
