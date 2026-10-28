import type Anthropic from '@anthropic-ai/sdk';

import type { BreakerRunner } from './anthropicBreakers.js';
import { createAnthropicConverseWithTools } from './anthropicConverseWithTools.js';
import { createAnthropicGenerateTool } from './anthropicGenerateTool.js';
import type { LlmProvider } from './provider.js';

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
  return {
    generateTool: createAnthropicGenerateTool({ client, runInBreaker: runGenerateTool }),
    converseWithTools: createAnthropicConverseWithTools({
      client,
      runInBreaker: runConverse,
    }),
  };
}
