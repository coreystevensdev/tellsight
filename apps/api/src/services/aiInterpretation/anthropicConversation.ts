import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../../lib/logger.js';
import type { PromptInput, ToolDefinition, ToolResultInput } from './provider.js';

// String content (a plain user question) or an array of content blocks are
// both valid; a null/non-object block would otherwise crash the tool_use scan
// with a raw TypeError instead of a clear caller-contract error.
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

// `[].every(...)` is vacuously true, so an empty array needs its own check --
// state is never legitimately empty, it's either null (first turn) or a
// non-empty history returned by the provider.
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

// The last message in valid state is the assistant turn that triggered this
// round-trip, so its tool_use blocks are exactly the ids these results answer.
function pendingToolUseIds(state: Anthropic.MessageParam[]): Set<string> {
  const content = state.at(-1)?.content;
  if (!Array.isArray(content)) return new Set();

  // typeof is not redundant with the types: isMessageParamArray only proves each
  // block has a string `type`, so an id-less tool_use block can reach here.
  return new Set(
    content.flatMap((block) =>
      block.type === 'tool_use' && typeof block.id === 'string' ? [block.id] : [],
    ),
  );
}

// Tool output round-trips back into the model's context on every remaining
// turn, so one oversized or bidi/zero-width-laced uploaded value compounds.
// This is character-level filtering, not semantic prompt-injection detection.
const MAX_TOOL_RESULT_CONTENT_LENGTH = 4000;
// Node 20+ supports Unicode set subtraction under the `v` flag; construction
// avoids TypeScript's es2024-only literal-regex flag check.
const UNSAFE_CODE_POINTS = new RegExp('[\\p{Cc}\\u2028\\u2029[\\p{Cf}--[\\u200c\\u200d]]]', 'gv');
const TRUNCATION_MARKER = '... [truncated]';
const FINAL_TURN_NOTICE =
  'No further tool calls are available. Answer now using only what has already been gathered.';

// value.slice can land inside a UTF-16 surrogate pair. Back off one code unit
// when the requested cut would leave a lone high surrogate.
function safeSlice(value: string, length: number): string {
  const lastCodeUnit = value.charCodeAt(length - 1);
  const cutsHighSurrogate = length > 0 && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
  return value.slice(0, cutsHighSurrogate ? length - 1 : length);
}

function sanitizeToolResultContent(output: unknown): string {
  const raw = JSON.stringify(output) ?? String(output);
  const stripped = raw.replace(UNSAFE_CODE_POINTS, '');

  if (stripped.length !== raw.length) {
    logger.warn(
      { removedCount: raw.length - stripped.length },
      'Tool result content had unsafe code points stripped before re-entering the conversation',
    );
  }

  if (stripped.length <= MAX_TOOL_RESULT_CONTENT_LENGTH) return stripped;

  logger.warn(
    { preTruncationLength: stripped.length, cap: MAX_TOOL_RESULT_CONTENT_LENGTH },
    'Tool result content exceeded the length cap and was truncated before re-entering the conversation',
  );
  return (
    safeSlice(stripped, MAX_TOOL_RESULT_CONTENT_LENGTH - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

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

  const toolResultBlocks = toolResults.map((result) => ({
    type: 'tool_result' as const,
    tool_use_id: result.toolCallId,
    content: sanitizeToolResultContent(result.output),
    ...(result.isError && { is_error: true }),
  }));

  return [
    ...state,
    {
      role: 'user',
      content:
        tools.length === 0
          ? [...toolResultBlocks, { type: 'text' as const, text: FINAL_TURN_NOTICE }]
          : toolResultBlocks,
    },
  ];
}
