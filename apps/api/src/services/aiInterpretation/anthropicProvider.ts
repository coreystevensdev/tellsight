import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import type {
  LlmProvider,
  PromptInput,
  ProviderHealth,
} from './provider.js';
import { createAnthropicBreakerRunners } from './anthropicBreakers.js';
import { createAnthropicHealthProbe } from './anthropicHealth.js';
import { modelFor } from './anthropicRequest.js';
import { createAnthropicProseMethods } from './anthropicProseProvider.js';
import { createAnthropicStream } from './anthropicStreamProvider.js';
import { createAnthropicToolMethods } from './anthropicToolProvider.js';
import { registerProvider } from './provider.js';

export type {
  StreamResult,
  ToolDefinition,
  ToolCall,
  ToolResultInput,
  ConversationTurn,
} from './provider.js';

const client = new Anthropic({
  apiKey: env.CLAUDE_API_KEY,
  maxRetries: 2,
  timeout: 15_000,
});

const {
  runProse: runInBreaker,
  runTool: runToolInBreaker,
  runConverse: runConverseInBreaker,
} = createAnthropicBreakerRunners();

export { modelFor };

const runHealthProbe = createAnthropicHealthProbe(client);

export async function probeClaudeHealth(): Promise<ProviderHealth> {
  return runHealthProbe();
}

const anthropicHealth = probeClaudeHealth;

const { generate: anthropicGenerate, generateWithModel: runGenerateWithModel } =
  createAnthropicProseMethods({ client, runInBreaker });

/**
 * Generate against a named model rather than whatever the path resolves to.
 *
 * Exists for the eval harness, which has to hold the judge fixed while the model
 * under test changes: judging with the model being judged makes a lenient grader
 * look like a better writer. Goes through the same breaker and cost gate as
 * everything else, so a judge run is bounded and costed like any other call.
 */
export async function generateWithModel(input: PromptInput, model: string): Promise<string> {
  return runGenerateWithModel(input, model);
}

const {
  generateTool: anthropicGenerateTool,
  converseWithTools: anthropicConverseWithTools,
} = createAnthropicToolMethods({
  client,
  runGenerateTool: runToolInBreaker,
  runConverse: runConverseInBreaker,
});

const anthropicStream = createAnthropicStream({ client, runInBreaker });

export const anthropicProvider: LlmProvider = {
  name: 'anthropic',
  generate: anthropicGenerate,
  stream: anthropicStream,
  generateTool: anthropicGenerateTool,
  converseWithTools: anthropicConverseWithTools,
  checkHealth: anthropicHealth,
};

// Self-register at module load. Callers that need the provider reach it via
// getProvider(); test files that mock this module entirely will skip this line,
// which is fine, those tests don't exercise the provider seam.
registerProvider(anthropicProvider);
