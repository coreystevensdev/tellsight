import type Anthropic from '@anthropic-ai/sdk';

import { validateConversationContinuation } from './anthropicConversationState.js';
import { sanitizeToolResultContent } from './anthropicToolResultContent.js';
import type { PromptInput, ToolDefinition, ToolResultInput } from './provider.js';

const FINAL_TURN_NOTICE =
  'No further tool calls are available. Answer now using only what has already been gathered.';

/**
 * Builds one Anthropic conversation turn and validates opaque state returned by
 * the previous turn. This stays outside the circuit breaker: malformed caller
 * state is a programming error, not an upstream Claude failure.
 */
export function buildConversationMessages(
  state: unknown,
  input: PromptInput,
  tools: ToolDefinition[],
  toolResults: ToolResultInput[],
): Anthropic.MessageParam[] {
  if (state === null) return [{ role: 'user', content: input.user }];
  const conversationState = validateConversationContinuation(state, toolResults);

  const toolResultBlocks = toolResults.map((result) => ({
    type: 'tool_result' as const,
    tool_use_id: result.toolCallId,
    content: sanitizeToolResultContent(result.output),
    ...(result.isError && { is_error: true }),
  }));

  return [
    ...conversationState,
    {
      role: 'user',
      content:
        tools.length === 0
          ? [...toolResultBlocks, { type: 'text' as const, text: FINAL_TURN_NOTICE }]
          : toolResultBlocks,
    },
  ];
}
