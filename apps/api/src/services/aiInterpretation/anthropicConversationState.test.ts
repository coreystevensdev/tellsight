import { describe, expect, it } from 'vitest';

import { validateConversationContinuation } from './anthropicConversationState.js';

const state = [
  { role: 'user', content: 'question' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} },
    ],
  },
];

describe('validateConversationContinuation', () => {
  it('returns valid state unchanged and allows a subset of pending results', () => {
    expect(
      validateConversationContinuation(state, [{ toolCallId: 'call_2', output: { ok: true } }]),
    ).toBe(state);
  });

  it.each([
    ['non-array state', 'opaque'],
    ['empty state', []],
    ['invalid role', [{ role: 'system', content: 'bad' }]],
    ['empty block content', [{ role: 'assistant', content: [] }]],
    ['null block', [{ role: 'assistant', content: [null] }]],
  ])('rejects %s', (_label, invalidState) => {
    expect(() =>
      validateConversationContinuation(invalidState, [{ toolCallId: 'call_1', output: {} }]),
    ).toThrow();
  });

  it('requires at least one result for a continuation', () => {
    expect(() => validateConversationContinuation(state, [])).toThrow(
      'toolResults must be non-empty',
    );
  });

  it('rejects duplicate result ids', () => {
    expect(() =>
      validateConversationContinuation(state, [
        { toolCallId: 'call_1', output: {} },
        { toolCallId: 'call_1', output: {} },
      ]),
    ).toThrow('duplicate toolCallId');
  });

  it('rejects a result that does not answer the last assistant turn', () => {
    expect(() =>
      validateConversationContinuation(state, [{ toolCallId: 'call_9', output: {} }]),
    ).toThrow('does not match a pending tool_use id');
  });
});
