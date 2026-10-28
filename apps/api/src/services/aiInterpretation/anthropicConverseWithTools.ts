import type Anthropic from '@anthropic-ai/sdk';

import { CostBudgetExceededError } from '../../lib/appError.js';
import { logger } from '../../lib/logger.js';
import type { BreakerRunner } from './anthropicBreakers.js';
import { buildConversationMessages } from './anthropicConversation.js';
import {
  MAX_OUTPUT_TOKENS,
  modelFor,
  systemParam,
  toolParams,
} from './anthropicRequest.js';
import { AbortedByClient, applyCostGate, mapAnthropicError } from './anthropicRuntime.js';
import {
  buildConversationTurn,
  isAbnormalToolStop,
} from './anthropicToolResponse.js';
import type { LlmProvider } from './provider.js';

interface ConverseWithToolsDependencies {
  client: Anthropic;
  runInBreaker: BreakerRunner;
}

export function createAnthropicConverseWithTools({
  client,
  runInBreaker,
}: ConverseWithToolsDependencies): LlmProvider['converseWithTools'] {
  return async function converseWithTools(state, input, tools, toolResults, signal) {
    const messages = buildConversationMessages(state, input, tools, toolResults);

    return runInBreaker(async () => {
      try {
        const model = modelFor('tools');
        const message = await client.messages.create(
          {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...(systemParam(input) && { system: systemParam(input) }),
            messages,
            ...(tools.length > 0 && {
              tools: toolParams(tools),
              tool_choice: { type: 'auto' as const },
            }),
          },
          { signal },
        );

        const isAbnormalStop = isAbnormalToolStop(message.stop_reason);
        if (message.stop_reason === 'max_tokens') {
          logger.warn(
            { model, usage: message.usage },
            'Claude API multi-turn tool conversation truncated at max_tokens, tool_use input or text may be incomplete',
          );
        } else if (isAbnormalStop) {
          logger.warn(
            { model, usage: message.usage, stopReason: message.stop_reason },
            'Claude API multi-turn tool conversation ended for an unexpected reason',
          );
        }

        const turn = buildConversationTurn(message, messages, model);
        const cost = applyCostGate(message.usage, 'converseWithTools', model);

        logger.info(
          { model, usage: message.usage, cost, toolCallCount: turn.toolCalls.length },
          'Claude API multi-turn tool conversation turn received',
        );

        return turn;
      } catch (err) {
        if (err instanceof CostBudgetExceededError) throw err;
        if (signal?.aborted) {
          logger.info({ aborted: true }, 'Claude API multi-turn tool conversation aborted by client');
          throw new AbortedByClient();
        }
        mapAnthropicError(err);
      }
    });
  };
}
