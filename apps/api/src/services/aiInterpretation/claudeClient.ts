import { cachedHealth, type PeekedHealth } from '../../lib/cachedHealth.js';
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

/**
 * Last known Claude health, without probing for it.
 *
 * A separate export rather than a property on checkClaudeHealth: this codebase
 * mocks modules by listing their exports, so a function carrying a second
 * function as a field is invisible to every `vi.mock` that does not know to
 * rebuild it. The first version of this shipped as `checkClaudeHealth.peek`
 * and took out fourteen health route tests with a 500, because the mock was a
 * bare vi.fn and the property was undefined.
 */
export function peekClaudeHealth(): PeekedHealth<ProviderHealth> | null {
  return checkClaudeHealth.peek();
}

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
 * summary, and so /health has an answer to report: it peeks at this cache
 * rather than probing. An unreachable AI resolves rather than throwing, so the
 * only rejection left is an unregistered provider, which index.ts catches.
 */
export async function logClaudeKeyStatus(): Promise<void> {
  // The cached wrapper, not the bare probe. It probes for real on an empty
  // cache so boot is no less fresh, and it leaves the answer behind: without
  // it, #295 left both health endpoints on "not probed since boot".
  const health = await checkClaudeHealth();

  if (health.status === 'error') {
    // Not 'Claude key rejected'. That was accurate while a rejected key was the
    // only thing this status could mean, and stopped being so once an exhausted
    // balance started reporting error too: production logged "Anthropic account
    // is out of credit" and "Claude key rejected" back to back on 2026-10-26,
    // which points whoever reads it at rotating a credential that is fine. The
    // detail already says which it is, so the message stops guessing.
    logger.error({ latencyMs: health.latencyMs, detail: health.detail }, 'Claude unusable at boot');
    return;
  }

  if (health.status === 'degraded') {
    logger.warn({ latencyMs: health.latencyMs }, 'Could not verify the Claude key at boot');
    return;
  }

  logger.info({ latencyMs: health.latencyMs }, 'Claude reachable and billable');
}
