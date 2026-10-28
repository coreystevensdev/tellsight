import type Anthropic from '@anthropic-ai/sdk';

import type { ToolResultInput } from './provider.js';

// String content and non-empty content-block arrays are both valid. Explicit
// object checks prevent malformed blocks from failing later with a raw TypeError.
function isValidMessageContent(content: unknown): boolean {
  if (typeof content === 'string') return true;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        typeof (block as { type?: unknown }).type === 'string',
    )
  );
}

function isMessageParamArray(value: unknown): value is Anthropic.MessageParam[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((message) => {
      if (typeof message !== 'object' || message === null) return false;
      const { role, content } = message as { role?: unknown; content?: unknown };
      return (role === 'user' || role === 'assistant') && isValidMessageContent(content);
    })
  );
}

// The last assistant turn contains the tool_use ids that this continuation may
// answer. State validation only guarantees a string block type, so guard id too.
function pendingToolUseIds(state: Anthropic.MessageParam[]): Set<string> {
  const content = state.at(-1)?.content;
  if (!Array.isArray(content)) return new Set();

  return new Set(
    content.flatMap((block) =>
      block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : [],
    ),
  );
}

export function validateConversationContinuation(
  state: unknown,
  toolResults: ToolResultInput[],
): Anthropic.MessageParam[] {
  if (!Array.isArray(state)) {
    throw new Error(
      `converseWithTools: state must be the message array returned by a prior turn, got ${typeof state}`,
    );
  }
  if (!isMessageParamArray(state)) {
    throw new Error(
      'converseWithTools: state does not match the message shape returned by a prior turn',
    );
  }
  if (toolResults.length === 0) {
    throw new Error('converseWithTools: toolResults must be non-empty once state is non-null');
  }

  const pendingIds = pendingToolUseIds(state);
  const seen = new Set<string>();
  for (const result of toolResults) {
    if (seen.has(result.toolCallId)) {
      throw new Error(
        `converseWithTools: duplicate toolCallId in toolResults: ${result.toolCallId}`,
      );
    }
    seen.add(result.toolCallId);

    if (!pendingIds.has(result.toolCallId)) {
      throw new Error(
        `converseWithTools: toolCallId ${result.toolCallId} does not match a pending tool_use id`,
      );
    }
  }

  return state;
}
