import type Anthropic from '@anthropic-ai/sdk';

import { CostBudgetExceededError } from '../../lib/appError.js';
import { logger } from '../../lib/logger.js';
import { aiToolCallsDropped } from '../../lib/metrics.js';
import { buildConversationMessages } from './anthropicConversation.js';
import {
  AbortedByClient,
  MAX_OUTPUT_TOKENS,
  applyCostGate,
  mapAnthropicError,
  modelFor,
  systemParam,
  toolParams,
} from './anthropicProviderSupport.js';
import type {
  ConversationTurn,
  LlmProvider,
  PromptInput,
  ToolCall,
  ToolDefinition,
  ToolResultInput,
} from './provider.js';

type BreakerRunner = <T>(operation: () => Promise<T>) => Promise<T>;

interface AnthropicToolDependencies {
  client: Anthropic;
  runGenerateTool: BreakerRunner;
  runConverse: BreakerRunner;
}

type AnthropicToolMethods = Pick<LlmProvider, 'generateTool' | 'converseWithTools'>;

export function createAnthropicToolMethods({
  client,
  runGenerateTool,
  runConverse,
}: AnthropicToolDependencies): AnthropicToolMethods {
  async function generateTool(
    input: PromptInput,
    tools: ToolDefinition[],
    onCost?: (cost: number | null) => void,
  ): Promise<ToolCall[]> {
    // With no tools the API cannot return tool_use, so avoid a call whose only
    // possible useful result is already known.
    if (tools.length === 0) return [];

    return runGenerateTool(async () => {
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

        const calls: ToolCall[] = message.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({ id: block.id, name: block.name, input: block.input }));

        const textBlockCount = message.content.filter((block) => block.type === 'text').length;
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

        // There is no signal for which tool_use block an abnormal stop clipped,
        // so drop the batch rather than act on possibly incomplete JSON.
        if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
          if (calls.length > 0) {
            aiToolCallsDropped.inc({
              caller: 'generateTool',
              reason: message.stop_reason === 'max_tokens' ? 'max_tokens' : 'abnormal_stop_reason',
            });
          }
          return [];
        }

        return calls;
      } catch (err) {
        mapAnthropicError(err);
      }
    });
  }

  async function converseWithTools(
    state: unknown,
    input: PromptInput,
    tools: ToolDefinition[],
    toolResults: ToolResultInput[],
    signal?: AbortSignal,
  ): Promise<ConversationTurn> {
    // Caller-contract violations stay outside the breaker: they are programmer
    // errors, not evidence that Claude is unhealthy.
    const messages = buildConversationMessages(state, input, tools, toolResults);

    return runConverse(async () => {
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

        const isAbnormalStop =
          message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use';

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

        let toolCalls: ToolCall[] = message.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({ id: block.id, name: block.name, input: block.input }));

        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        if (text.length > 0 && toolCalls.length > 0) {
          logger.info(
            { model, toolCallCount: toolCalls.length },
            'Claude API multi-turn tool conversation turn included text alongside tool calls',
          );
        }

        if (isAbnormalStop) {
          if (toolCalls.length > 0) {
            aiToolCallsDropped.inc({
              caller: 'converseWithTools',
              reason: message.stop_reason === 'max_tokens' ? 'max_tokens' : 'abnormal_stop_reason',
            });
          }
          toolCalls = [];
        }

        const cost = applyCostGate(message.usage, 'converseWithTools', model);

        logger.info(
          { model, usage: message.usage, cost, toolCallCount: toolCalls.length },
          'Claude API multi-turn tool conversation turn received',
        );

        // Anthropic documents feeding response blocks directly into the next
        // assistant message, though its input/output SDK types differ.
        const assistantContent = message.content as unknown as Anthropic.MessageParam['content'];
        const nextState: Anthropic.MessageParam[] = [
          ...messages,
          { role: 'assistant', content: assistantContent },
        ];

        return {
          state: nextState,
          toolCalls,
          text,
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          },
        };
      } catch (err) {
        // Cost errors take precedence over a concurrently aborted request.
        if (err instanceof CostBudgetExceededError) throw err;
        if (signal?.aborted) {
          logger.info({ aborted: true }, 'Claude API multi-turn tool conversation aborted by client');
          throw new AbortedByClient();
        }
        mapAnthropicError(err);
      }
    });
  }

  return { generateTool, converseWithTools };
}
