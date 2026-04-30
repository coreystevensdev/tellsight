/**
 * Rolling-median cost anomaly detector for AI calls.
 *
 * Purpose: catch a single Claude call that costs dramatically more than the
 * usual one, a runaway prompt, a multi-page payload, a pricing
 * misconfiguration. Modelled on InvoiceFlow's cost.ts (NFR-R4 there).
 *
 * Invariants worth knowing:
 *   - Per-instance state. Each Node process has its own history and median.
 *     Acceptable for an anomaly detector; not acceptable for a global quota.
 *     Move to Redis if/when this needs to be a real spending cap across
 *     replicas.
 *   - Post-call check. By the time we know the cost, the tokens are spent.
 *     Real prevention is upstream: SDK maxRetries (2) and request timeout
 *     (15s) in claudeClient.ts. This file detects and reports anomalies.
 *   - Race window between read and append: two concurrent calls can both
 *     pass the check. Locking would not reduce spend already incurred.
 *   - Failing open: unknown model returns `null` cost; budget check is
 *     skipped. A defensive default, better than refusing service when an
 *     operator configures a new model variant.
 *
 * Anthropic pricing per 1M tokens (as of 2026-04):
 *   claude-sonnet-4-5: input $3,  output $15
 *   claude-sonnet-4-6: input $3,  output $15
 *   claude-opus-4-7:   input $15, output $75
 *   claude-haiku-4-5:  input $1,  output $5
 */

import { env } from '../config.js';

export const CAP_MULTIPLIER = 3;
export const ABSOLUTE_CEILING_USD = 1.0;
const HISTORY_CAP = 50;

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-6': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-opus-4-7': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export function computeCost(usage: Usage, model: string = env.CLAUDE_MODEL): number | null {
  // Destructure from entries so the price object is non-nullable in scope
  // PRICING[key] under noUncheckedIndexedAccess returns T | undefined.
  const entry = Object.entries(PRICING).find(([prefix]) => model.startsWith(prefix));
  if (!entry) return null;
  const [, p] = entry;
  return (
    (usage.input_tokens / 1_000_000) * p.inputPerMillion +
    (usage.output_tokens / 1_000_000) * p.outputPerMillion
  );
}

const history: number[] = [];

export function recordCost(cost: number): void {
  if (!Number.isFinite(cost) || cost < 0) return;
  history.push(cost);
  if (history.length > HISTORY_CAP) history.shift();
}

export function medianCost(): number | null {
  if (history.length === 0) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Bounds are mathematically proven (length > 0, mid < length) but
  // noUncheckedIndexedAccess can't see it. The non-null assertions are safe.
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export interface BudgetCheck {
  exceeded: boolean;
  observed: number;
  cap: number | null;
  median: number | null;
}

export function exceedsBudget(current: number): BudgetCheck {
  const median = medianCost();

  // Cold-start floor: the rolling median is unseeded for the first request,
  // so the absolute ceiling is the only thing that bounds a misconfigured
  // first invocation on Opus.
  if (current > ABSOLUTE_CEILING_USD) {
    return { exceeded: true, observed: current, cap: ABSOLUTE_CEILING_USD, median };
  }

  if (median === null || median === 0) {
    return { exceeded: false, observed: current, cap: null, median };
  }

  const cap = median * CAP_MULTIPLIER;
  return { exceeded: current > cap, observed: current, cap, median };
}

export function resetHistoryForTests(): void {
  history.length = 0;
}
