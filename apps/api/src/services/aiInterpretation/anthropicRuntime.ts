import Anthropic from '@anthropic-ai/sdk';

import { CostBudgetExceededError, ExternalServiceError } from '../../lib/appError.js';
import {
  computeCost,
  exceedsBudget,
  recordCost,
  recordRefusedCost,
  type Usage,
} from '../../lib/cost.js';
import { logger } from '../../lib/logger.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';

export class AbortedByClient extends Error {
  constructor() {
    super('aborted by client');
  }
}

// Non-streaming calls can refuse an anomalously expensive response after the
// tokens are spent. A refused cost stays out of median history so one runaway
// cannot raise the floor, but a sustained run of them clears it instead, see
// recordRefusedCost in lib/cost.ts.
export function applyCostGate(usage: Usage, caller: string, model: string): number | null {
  const cost = computeCost(usage, model);
  if (cost === null) {
    logger.error({ model, caller }, 'No pricing for model, cost gate skipped');
    return null;
  }

  const budget = exceedsBudget(cost, model);
  if (budget.exceeded) {
    aiCostBudgetExceeded.inc({ caller });
    const recalibrated = recordRefusedCost(cost, model);
    logger.warn(
      { cost, cap: budget.cap, median: budget.median, model, recalibrated },
      recalibrated
        ? 'Claude API cost budget exceeded, request refused, cost floor cleared to follow the new level'
        : 'Claude API cost budget exceeded, request refused',
    );
    throw new CostBudgetExceededError(cost, budget.cap);
  }
  recordCost(cost, model);
  return cost;
}

export function mapAnthropicError(err: unknown): never {
  if (err instanceof CostBudgetExceededError) throw err;

  // A 400 or a 401 is a fact about the request or the account rather than
  // weather: a bad key, a malformed call, an exhausted credit balance. No amount
  // of retrying changes any of them. This split already existed to pick a log
  // level and was then discarded, so every caller saw the same error whether the
  // upstream had timed out once or the account had run dry. The eval burned 72
  // samples over 40 minutes discovering the second case one sample at a time.
  const permanent =
    err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError;

  if (permanent) {
    logger.error({ err: (err as Error).message }, 'Claude API non-retryable error');
  } else {
    logger.warn({ err: (err as Error).message }, 'Claude API retryable error exhausted');
  }

  throw new ExternalServiceError('Claude API', {
    originalError: (err as Error).message,
    permanent,
  });
}
