import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({
  env: { CLAUDE_MODEL: 'claude-sonnet-4-6' },
}));

import {
  firstText,
  singleTurnPrompt,
  systemParams,
  toolParams,
} from './anthropicRequest.js';

describe('Anthropic request helpers', () => {
  it('omits the system property when the system prompt is empty', () => {
    expect(systemParams({ system: '', user: 'question' })).toEqual({});
    expect(singleTurnPrompt({ system: '', user: 'question' })).toEqual({
      messages: [{ role: 'user', content: 'question' }],
    });
  });

  it('marks a non-empty system prompt as ephemeral cache content', () => {
    expect(singleTurnPrompt({ system: 'Follow these rules', user: 'question' })).toEqual({
      system: [
        {
          type: 'text',
          text: 'Follow these rules',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'question' }],
    });
  });

  it('maps provider-neutral tool definitions to Anthropic input schemas', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } };

    expect(toolParams([{ name: 'lookup', description: 'Find a row', inputSchema: schema }])).toEqual([
      { name: 'lookup', description: 'Find a row', input_schema: schema },
    ]);
  });

  it('selects the first text block after non-text content', () => {
    expect(
      firstText([
        { type: 'thinking' },
        { type: 'text', text: 'answer' } as { type: string },
        { type: 'text', text: 'ignored' } as { type: string },
      ]),
    ).toBe('answer');
  });

  it('returns an empty string when content has no text block', () => {
    expect(firstText([{ type: 'thinking' }, { type: 'tool_use' }])).toBe('');
  });
});
