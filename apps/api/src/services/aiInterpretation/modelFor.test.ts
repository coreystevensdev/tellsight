import { describe, it, expect, vi } from 'vitest';

const env: { CLAUDE_MODEL: string; CLAUDE_MODEL_TOOLS?: string } = {
  CLAUDE_MODEL: 'claude-sonnet-4-5-20250929',
};

vi.mock('../../config.js', () => ({ env }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { models = { list: vi.fn() }; messages = {} } }));

const { modelFor } = await import('./claudeClient.js');

describe('modelFor', () => {
  it('sends both paths to the same model when no override is set', () => {
    env.CLAUDE_MODEL_TOOLS = undefined;

    expect(modelFor('prose')).toBe('claude-sonnet-4-5-20250929');
    expect(modelFor('tools')).toBe('claude-sonnet-4-5-20250929');
  });

  // The point of the split: pay for prose, which is the product's claim, and let
  // the tool paths run on something that only has to return the right shape.
  it('sends the tool paths to the override, and leaves prose alone', () => {
    env.CLAUDE_MODEL_TOOLS = 'claude-haiku-4-5';

    expect(modelFor('tools')).toBe('claude-haiku-4-5');
    expect(modelFor('prose')).toBe('claude-sonnet-4-5-20250929');
  });

  it('reads the override every call, not once at module load', () => {
    env.CLAUDE_MODEL_TOOLS = 'claude-haiku-4-5';
    expect(modelFor('tools')).toBe('claude-haiku-4-5');

    env.CLAUDE_MODEL_TOOLS = 'claude-opus-5';
    expect(modelFor('tools')).toBe('claude-opus-5');
  });
});
