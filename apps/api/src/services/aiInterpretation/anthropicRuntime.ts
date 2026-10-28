import Anthropic from '@anthropic-ai/sdk';

import { CostBudgetExceededError, ExternalServiceError } from '../../lib/appError.js';
import { computeCost, exceedsBudget, recordCost, type Usage } from '../../lib/cost.js';
import { logger } from '../../lib/logger.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';

export class AbortedByClient extends Error {
  constructor() {
    super('aborted by client');
  }
}

// Non-streaming calls can refuse an anomalously expensive response after the
// tokens are spent. Anomalies stay out of median history so they cannot raise
// the budget floor for subsequent calls.
export function applyCostGate(usage: Usage, caller: string, model: string): number | null {
  const cost = computeCost(usage, model);
  if (cost === null) {
    logger.error({ model, caller }, 'No pricing for model, cost gate skipped');
    return null;
  }

  const budget = exceedsBudget(cost);
  if (budget.exceeded) {
    aiCostBudgetExceeded.inc({ caller });
    logger.warn(
      { cost, cap: budget.cap, median: budget.median, model },
      'Claude API cost budget exceeded, request refused',
    );
    throw new CostBudgetExceededError(cost, budget.cap);
  }
  recordCost(cost);
  return cost;
}

export function mapAnthropicError(err: unknown): never {
  if (err instanceof CostBudgetExceededError) throw err;

  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) {
    logger.error({ err: (err as Error).message }, 'Claude API non-retryable error');
  } else {
    logger.warn({ err: (err as Error).message }, 'Claude API retryable error exhausted');
  }

  throw new ExternalServiceError('Claude API', {
    originalError: (err as Error).message,
  });
}
