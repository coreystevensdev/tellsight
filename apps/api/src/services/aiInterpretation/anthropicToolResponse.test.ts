import type Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDropMetric, mockLogger } = vi.hoisted(() => ({
  mockDropMetric: { inc: vi.fn() },
  mockLogger: { info: vi.fn() },
}));

vi.mock('../../lib/metrics.js', () => ({ aiToolCallsDropped: mockDropMetric }));
vi.mock('../../lib/logger.js', () => ({
  logger: { ...mockLogger, warn: vi.fn(), error: vi.fn() },
}));

import {
  buildConversationTurn,
  countTextBlocks,
  extractText,
  extractToolCalls,
  isAbnormalToolStop,
  retainCompleteToolCalls,
} from './anthropicToolResponse.js';

const content = [
  { type: 'text', text: 'before' },
  { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 7 } },
  { type: 'text', text: 'after' },
] as Anthropic.Message['content'];

describe('Anthropic tool-response helpers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts tool calls and joins every text block', () => {
    expect(extractToolCalls(content)).toEqual([
      { id: 'call_1', name: 'lookup', input: { id: 7 } },
    ]);
    expect(extractText(content)).toBe('beforeafter');
    expect(countTextBlocks(content)).toBe(2);
  });

  it('recognizes only end_turn and tool_use as complete stops', () => {
    expect(isAbnormalToolStop('end_turn')).toBe(false);
    expect(isAbnormalToolStop('tool_use')).toBe(false);
    expect(isAbnormalToolStop('max_tokens')).toBe(true);
    expect(isAbnormalToolStop(null)).toBe(true);
  });

  it('retains complete calls without emitting a drop metric', () => {
    const calls = extractToolCalls(content);

    expect(retainCompleteToolCalls(calls, 'tool_use', 'generateTool')).toBe(calls);
    expect(mockDropMetric.inc).not.toHaveBeenCalled();
  });

  it('drops and records calls from a truncated response', () => {
    const calls = extractToolCalls(content);

    expect(retainCompleteToolCalls(calls, 'max_tokens', 'generateTool')).toEqual([]);
    expect(mockDropMetric.inc).toHaveBeenCalledWith({
      caller: 'generateTool',
      reason: 'max_tokens',
    });
  });

  it('does not emit a drop metric when an abnormal response contains no calls', () => {
    expect(retainCompleteToolCalls([], null, 'converseWithTools')).toEqual([]);
    expect(mockDropMetric.inc).not.toHaveBeenCalled();
  });

  it('builds the next conversation state, text, calls, and normalized usage', () => {
    const messages = [{ role: 'user' as const, content: 'question' }];
    const message = {
      content,
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 8 },
    } as Anthropic.Message;

    expect(buildConversationTurn(message, messages, 'claude-test')).toEqual({
      state: [...messages, { role: 'assistant', content }],
      toolCalls: [{ id: 'call_1', name: 'lookup', input: { id: 7 } }],
      text: 'beforeafter',
      usage: { inputTokens: 12, outputTokens: 8 },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      { model: 'claude-test', toolCallCount: 1 },
      'Claude API multi-turn tool conversation turn included text alongside tool calls',
    );
  });
});
