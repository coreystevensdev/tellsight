import { cachedHealth } from '../../lib/cachedHealth.js';
import { logger } from '../../lib/logger.js';
import {
  anthropicProvider,
  generateWithModel,
  modelFor,
  probeClaudeHealth,
} from './anthropicProvider.js';
import type {
  ConversationTurn,
  PromptInput,
  ProviderHealth,
  StreamResult,
  ToolCall,
  ToolDefinition,
  ToolResultInput,
} from './provider.js';
import { getProvider } from './provider.js';

export type { StreamResult, ToolDefinition, ToolCall, ToolResultInput, ConversationTurn };
export { anthropicProvider, generateWithModel, modelFor, probeClaudeHealth };

// This facade is the stable application import path. Provider construction and
// registration happen in anthropicProvider; callers stay provider-agnostic.
export async function generateInterpretation(input: PromptInput): Promise<string> {
  return getProvider().generate(input);
}

export async function streamInterpretation(
  input: PromptInput,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return getProvider().stream(input, onText, signal);
}

// Five minutes, same reasoning as stripeHealth: /health is curled every thirty
// seconds by the container healthcheck and this answer changes on a rotation.
export const checkClaudeHealth = cachedHealth(5 * 60 * 1000, async (): Promise<ProviderHealth> =>
  getProvider().checkHealth(),
);

export async function generateWithTools(
  input: PromptInput,
  tools: ToolDefinition[],
  onCost?: (cost: number | null) => void,
): Promise<ToolCall[]> {
  return getProvider().generateTool(input, tools, onCost);
}

export async function converseWithTools(
  state: unknown,
  input: PromptInput,
  tools: ToolDefinition[],
  toolResults: ToolResultInput[],
  signal?: AbortSignal,
): Promise<ConversationTurn> {
  return getProvider().converseWithTools(state, input, tools, toolResults, signal);
}

/**
 * Runs once at boot so a rejected key is visible before someone asks for a
 * summary. Uncached, since the cache is empty this early and boot wants a fresh
 * answer. Never throws: the AI being unreachable should not stop the dashboard,
 * the connectors or the digests from serving.
 */
export async function logClaudeKeyStatus(): Promise<void> {
  const health = await probeClaudeHealth();

  if (health.status === 'error') {
    logger.error({ latencyMs: health.latencyMs, detail: health.detail }, 'Claude key rejected');
    return;
  }

  if (health.status === 'degraded') {
    logger.warn({ latencyMs: health.latencyMs }, 'Could not verify the Claude key at boot');
    return;
  }

  logger.info({ latencyMs: health.latencyMs }, 'Claude reachable and billable');
}
