import type Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import type { PromptInput, ToolDefinition } from './provider.js';

// Raised from 1024 on 2026-09-18. Newer models spend output tokens on
// thinking, so tool paths need enough headroom to avoid dropping truncated
// tool-call batches.
export const MAX_OUTPUT_TOKENS = 2048;

/**
 * Prose powers interpretations, digests, and alert copy. Tools powers
 * proposals and the Q&A loop. Without an override both use the same model.
 */
export function modelFor(path: 'prose' | 'tools'): string {
  return path === 'tools' ? (env.CLAUDE_MODEL_TOOLS ?? env.CLAUDE_MODEL) : env.CLAUDE_MODEL;
}

// A response can begin with a thinking block; select the first text block
// rather than assuming text is at index zero.
export function firstText(content: Array<{ type: string }>): string {
  const block = content.find((item) => item.type === 'text');
  return block && 'text' in block ? String((block as { text: unknown }).text) : '';
}

// Return a spreadable fragment so empty prompts omit `system` entirely and
// callers do not need to compute the cached block twice.
export function systemParams(input: PromptInput) {
  if (!input.system) return {};
  return {
    system: [
      {
        type: 'text' as const,
        text: input.system,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
  };
}

export function singleTurnPrompt(input: PromptInput) {
  return {
    ...systemParams(input),
    messages: [{ role: 'user' as const, content: input.user }],
  };
}

export function toolParams(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}
