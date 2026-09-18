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

export const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

export function pricingFor(model: string): ModelPricing | null {
  const entry = Object.entries(PRICING).find(([prefix]) => model.startsWith(prefix));
  return entry ? entry[1] : null;
}

export const KNOWN_MODEL_PREFIXES = Object.keys(PRICING);
