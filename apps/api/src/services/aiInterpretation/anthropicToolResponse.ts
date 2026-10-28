import type Anthropic from '@anthropic-ai/sdk';

import { aiToolCallsDropped } from '../../lib/metrics.js';
import type { ToolCall } from './provider.js';

type StopReason = Anthropic.Message['stop_reason'];
type ToolCaller = 'generateTool' | 'converseWithTools';

export function isAbnormalToolStop(stopReason: StopReason): boolean {
  return stopReason !== 'end_turn' && stopReason !== 'tool_use';
}

export function extractToolCalls(content: Anthropic.Message['content']): ToolCall[] {
  return content
    .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));
}

export function extractText(content: Anthropic.Message['content']): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function countTextBlocks(content: Anthropic.Message['content']): number {
  return content.filter((block) => block.type === 'text').length;
}

/**
 * Anthropic does not identify which tool_use block an abnormal stop clipped.
 * Drop the entire batch rather than act on JSON that may be incomplete.
 */
export function retainCompleteToolCalls(
  toolCalls: ToolCall[],
  stopReason: StopReason,
  caller: ToolCaller,
): ToolCall[] {
  if (!isAbnormalToolStop(stopReason)) return toolCalls;

  if (toolCalls.length > 0) {
    aiToolCallsDropped.inc({
      caller,
      reason: stopReason === 'max_tokens' ? 'max_tokens' : 'abnormal_stop_reason',
    });
  }
  return [];
}
