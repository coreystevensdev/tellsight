import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import { CostBudgetExceededError, ExternalServiceError } from '../../lib/appError.js';
import { computeCost, exceedsBudget, recordCost, type Usage } from '../../lib/cost.js';
import { logger } from '../../lib/logger.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';
import type { PromptInput, ToolDefinition } from './provider.js';

export class AbortedByClient extends Error {
  constructor() {
    super('aborted by client');
  }
}

// Raised from 1024 on 2026-09-18. Sonnet 4.5 uses about 291 output tokens on a
// representative fixture, but the newer models spend output tokens on thinking:
// Sonnet 5 used 856 on the same one, 84% of the old cap. A max_tokens stop makes
// the tool paths drop every tool call in the response, so the headroom is not
// optional if a model that thinks is ever selected.
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * Which model a given path uses.
 *
 * 'prose' is the interpretation, the digest and the alert copy: the product's
 * claim is that it explains numbers well, so this is the one worth paying for.
 * 'tools' is proposals and the Q&A loop, which want a tool call in the right
 * shape more than they want good sentences.
 *
 * Unset CLAUDE_MODEL_TOOLS means both resolve to the same model, which is what
 * shipped before this existed.
 */
export function modelFor(path: 'prose' | 'tools'): string {
  return path === 'tools' ? (env.CLAUDE_MODEL_TOOLS ?? env.CLAUDE_MODEL) : env.CLAUDE_MODEL;
}

// The first text block, not the first block. A response can begin with a
// thinking block, which must not turn an otherwise valid response into ''.
export function firstText(content: Array<{ type: string }>): string {
  const block = content.find((item) => item.type === 'text');
  return block && 'text' in block ? String((block as { text: unknown }).text) : '';
}

// Build the SDK system parameter from PromptInput. Returns undefined when the
// system half is empty so the call shape matches the pre-caching path exactly.
export function systemParam(input: PromptInput) {
  if (!input.system) return undefined;
  return [
    {
      type: 'text' as const,
      text: input.system,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

export function toolParams(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

// Post-call cost gate shared by non-streaming provider methods. Tokens are
// already spent by the time cost is known, so this is an anomaly detector; the
// next request gets the benefit. Anomalies stay out of median history.
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
  // Preserve the domain error so the error handler can return its typed code.
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
