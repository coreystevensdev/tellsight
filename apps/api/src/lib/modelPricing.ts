/**
 * Per-million token prices, matched by model-id prefix.
 *
 * Lives apart from cost.ts so config.ts can validate CLAUDE_MODEL against it
 * without the two importing each other: cost.ts reads env, and config would
 * have had to read cost.
 *
 * A model that is not here has no price, and an unpriced call used to skip the
 * budget gate entirely rather than fail. Adding one is the price of changing
 * models, which is the point.
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Checked against platform.claude.com/docs/en/about-claude/pricing on 2026-09-18.
// Base input and output only: the cap reads usage.input_tokens and
// usage.output_tokens, so cache-write and cache-read tiers are not modelled and
// a cached call is costed slightly high. Erring high is the safe direction for a
// spend cap.
//
// Opus 4.7 was listed here at 15/75, which is Opus 4.1's price. It is 5/25. That
// made the cap compute Opus costs at three times the truth, so the $1 absolute
// ceiling would have refused legitimate calls and the cost tile overstated spend.
//
// Claude 4.7 and later use a newer tokenizer that produces roughly 30% more
// tokens for the same text, so a per-token price is not comparable across that
// line. Sonnet 5 is nominally 33% cheaper than Sonnet 4.5 and about 13% cheaper
// once the tokenizer is accounted for.
export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-5': { inputPerMillion: 2, outputPerMillion: 10 },
  'claude-opus-4-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-6': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-7': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-5': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

export function pricingFor(model: string): ModelPricing | null {
  const entry = Object.entries(PRICING).find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : null;
}

export const KNOWN_MODEL_PREFIXES = Object.keys(PRICING);
