/**
 * Rolling-median cost anomaly detector for AI calls.
 *
 * Purpose: catch a single Claude call that costs dramatically more than the
 * usual one, a runaway prompt, a multi-page payload, a pricing
 * misconfiguration. Modelled on InvoiceFlow's cost.ts.
 *
 * Invariants worth knowing:
 *   - Per-instance state. Each Node process has its own history and median.
 *     Acceptable for an anomaly detector; not acceptable for a global quota.
 *     Move to Redis if/when this needs to be a real spending cap across
 *     replicas.
 *   - A refused cost does not seed the median, but ADAPT_AFTER_CONSECUTIVE_REFUSALS
 *     of them in a row clears the window so the floor can follow a real shift.
 *   - Post-call check. By the time we know the cost, the tokens are spent.
 *     Real prevention is upstream: SDK maxRetries (2) and request timeout
 *     (15s) in claudeClient.ts. This file detects and reports anomalies.
 *   - Race window between read and append: two concurrent calls can both
 *     pass the check. Locking would not reduce spend already incurred.
 *   - Failing open at this helper boundary: an unexpected runtime model returns
 *     `null` cost and skips the budget check. Configured models are stricter:
 *     config.ts refuses to boot unless their exact rate is known.
 *
 * Rates are centralized in CLAUDE_PRICING under shared/constants so the
 * runtime cost guard and admin estimates always use the same source.
 */

import { env } from '../config.js';
import { pricingForClaudeModel } from 'shared/constants';

export const CAP_MULTIPLIER = 3;
export const ABSOLUTE_CEILING_USD = 1.0;
const HISTORY_CAP = 50;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export function computeCost(usage: Usage, model: string = env.CLAUDE_MODEL): number | null {
  const p = pricingForClaudeModel(model);
  if (!p) return null;
  return (
    (usage.input_tokens / 1_000_000) * p.inputPerMillion +
    (usage.output_tokens / 1_000_000) * p.outputPerMillion
  );
}

const history: number[] = [];

// A refused cost stays out of history so one runaway prompt cannot raise the
// floor for everything after it. On its own that leaves the floor unable to
// learn a new normal: when legitimate per-call cost steps up (a longer prompt
// version, more stats per dataset, a pricier model on a tool path), every call
// at the new level is refused, none is recorded, and the median stays pinned at
// the old level with no way back. Measured on 2026-11-03: 37 calls at $0.026 to
// $0.037 against a median that never left $0.0084 to $0.0118.
//
// So a run of refusals with no passing call between them is read as a shift
// rather than an anomaly, and clears the window to reseed at the real level.
// Clearing rather than admitting the cost: one sample barely moves a 50-entry
// median, so admitting would need hundreds of refusals to adapt.
export const ADAPT_AFTER_CONSECUTIVE_REFUSALS = 10;
let consecutiveRefusals = 0;

export function recordCost(cost: number): void {
  if (!Number.isFinite(cost) || cost < 0) return;
  consecutiveRefusals = 0;
  history.push(cost);
  if (history.length > HISTORY_CAP) history.shift();
}

// Call for a cost the gate refused. Returns true when the run was long enough
// to recalibrate, which the caller logs: a floor moving is worth a line.
// ABSOLUTE_CEILING_USD still applies afterwards, so recalibration widens the
// band the median sets and never removes the hard stop.
export function recordRefusedCost(cost: number): boolean {
  if (!Number.isFinite(cost) || cost < 0) return false;
  consecutiveRefusals += 1;
  if (consecutiveRefusals < ADAPT_AFTER_CONSECUTIVE_REFUSALS) return false;
  consecutiveRefusals = 0;
  history.length = 0;
  return true;
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
  consecutiveRefusals = 0;
}
