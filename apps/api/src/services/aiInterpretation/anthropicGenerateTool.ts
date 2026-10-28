import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../../lib/logger.js';
import type { BreakerRunner } from './anthropicBreakers.js';
import {
  MAX_OUTPUT_TOKENS,
  modelFor,
  systemParam,
  toolParams,
} from './anthropicRequest.js';
import { applyCostGate, mapAnthropicError } from './anthropicRuntime.js';
import {
  countTextBlocks,
  extractToolCalls,
  retainCompleteToolCalls,
} from './anthropicToolResponse.js';
import type { LlmProvider } from './provider.js';

interface GenerateToolDependencies {
  client: Anthropic;
  runInBreaker: BreakerRunner;
}

export function createAnthropicGenerateTool({
  client,
  runInBreaker,
}: GenerateToolDependencies): LlmProvider['generateTool'] {
  return async function generateTool(input, tools, onCost) {
    if (tools.length === 0) return [];

    return runInBreaker(async () => {
      try {
        const model = modelFor('tools');
        const message = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(systemParam(input) && { system: systemParam(input) }),
          messages: [{ role: 'user', content: input.user }],
          tools: toolParams(tools),
          tool_choice: { type: 'auto' },
        });

        if (message.stop_reason === 'max_tokens') {
          logger.warn(
            { model, usage: message.usage },
            'Claude API tool-use response truncated at max_tokens, dropping all tool calls from this response',
          );
        } else if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
          logger.warn(
            { model, usage: message.usage, stopReason: message.stop_reason },
            'Claude API tool-use response ended for an unexpected reason, dropping all tool calls from this response',
          );
        }

        const calls = extractToolCalls(message.content);
        const textBlockCount = countTextBlocks(message.content);
        if (textBlockCount > 0) {
          logger.info(
            { model, textBlockCount, toolCallCount: calls.length },
            'Claude API tool-use response included text alongside or instead of tool calls',
          );
        }

        const cost = applyCostGate(message.usage, 'generateTool', model);
        onCost?.(cost);

        logger.info(
          { model, usage: message.usage, cost, toolCallCount: calls.length },
          'Claude API tool-use response received',
        );
        return retainCompleteToolCalls(calls, message.stop_reason, 'generateTool');
      } catch (err) {
        mapAnthropicError(err);
      }
    });
  };
}
