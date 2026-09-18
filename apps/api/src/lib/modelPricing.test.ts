import { describe, it, expect } from 'vitest';

import { PRICING, pricingFor, KNOWN_MODEL_PREFIXES } from './modelPricing.js';

describe('pricingFor', () => {
  it('matches a dated model id by its prefix', () => {
    expect(pricingFor('claude-sonnet-4-5-20250929')).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
  });

  // The whole table exists so an unpriced model cannot slip past the cost gate,
  // and config.ts refuses to boot on a null from here.
  it('returns null for a model it does not know', () => {
    expect(pricingFor('claude-sonnet-5')).toBeNull();
    expect(pricingFor('gpt-4')).toBeNull();
    expect(pricingFor('')).toBeNull();
  });

  // A prefix that is itself a prefix of another would make matching depend on
  // object key order, which is not something to leave to chance in a price table.
  it('has no prefix that shadows another', () => {
    for (const a of KNOWN_MODEL_PREFIXES) {
      const shadowed = KNOWN_MODEL_PREFIXES.filter((b) => b !== a && b.startsWith(a));
      expect(shadowed, `${a} is a prefix of ${shadowed.join(', ')}`).toEqual([]);
    }
  });

  it('prices every entry above zero on both halves', () => {
    for (const [model, p] of Object.entries(PRICING)) {
      expect(p.inputPerMillion, model).toBeGreaterThan(0);
      expect(p.outputPerMillion, model).toBeGreaterThan(0);
    }
  });
});
