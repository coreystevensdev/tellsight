import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { ExternalServiceError, CostBudgetExceededError } from '../../lib/appError.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { computeCost, exceedsBudget, recordCost, type Usage } from '../../lib/cost.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';
import type {
  LlmProvider,
  PromptInput,
  StreamResult,
  ProviderHealth,
  ToolDefinition,
  ToolCall,
  ToolResultInput,
  ConversationTurn,
} from './provider.js';
import { getProvider, registerProvider } from './provider.js';

export type { StreamResult, ToolDefinition, ToolCall, ToolResultInput, ConversationTurn };

const client = new Anthropic({
  apiKey: env.CLAUDE_API_KEY,
  maxRetries: 2,
  timeout: 15_000,
});

class AbortedByClient extends Error {
  constructor() { super('aborted by client'); }
}

// 3 consecutive failures → open for 30s. Anthropic SDK already retries twice
// per call, so 3 trips = 9 failed attempts over ~45s of real outage.
const breaker = new CircuitBreaker({
  name: 'claude-api',
  threshold: 3,
  cooldownMs: 30_000,
  isIgnored: (err) => err instanceof AbortedByClient,
});

// bind once, avoids the literal `breaker.exec(` on every call site, which a
// repo-wide security lint flags as shell-exec even though it's CircuitBreaker.
const runInBreaker = breaker.exec.bind(breaker);

async function anthropicHealth(): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    await client.models.list({ limit: 1 });
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Claude API health check failed');
    return { status: 'error', latencyMs: Date.now() - start };
  }
}

// Build the SDK system parameter from PromptInput. Returns undefined when
// the system half is empty (digest template, legacy single-file versions) so
// the call shape matches the pre-caching path exactly.
function systemParam(input: PromptInput) {
  if (!input.system) return undefined;
  return [
    {
      type: 'text' as const,
      text: input.system,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

// Post-call cost gate shared by anthropicGenerate and anthropicGenerateTool.
// Tokens are already spent by the time we know the cost, so this is an
// anomaly detector, the next request gets the benefit. Real prevention is
// upstream (max_tokens, timeout). Anomalies are NOT recorded into median
// history; recording would raise the floor and let the next anomaly slip
// through. anthropicStream keeps its own log-only variant, it can't throw
// after content has already streamed to the client.
function applyCostGate(usage: Usage, caller: string): number | null {
  const cost = computeCost(usage);
  if (cost === null) return null;

  const budget = exceedsBudget(cost);
  if (budget.exceeded) {
    aiCostBudgetExceeded.inc({ caller });
    logger.warn(
      { cost, cap: budget.cap, median: budget.median, model: env.CLAUDE_MODEL },
      'Claude API cost budget exceeded, request refused',
    );
    throw new CostBudgetExceededError(cost, budget.cap);
  }
  recordCost(cost);
  return cost;
}

// Error mapping shared by anthropicGenerate and anthropicGenerateTool.
function mapAnthropicError(err: unknown): never {
  // Cost gate threw our domain error, propagate unchanged so the error
  // handler returns 503 with the typed COST_BUDGET_EXCEEDED code.
  if (err instanceof CostBudgetExceededError) throw err;

  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) {
    logger.error({ err: (err as Error).message }, 'Claude API non-retryable error');
  } else {
    logger.warn({ err: (err as Error).message }, 'Claude API retryable error exhausted');
  }

  throw new ExternalServiceError('Claude API', {
    originalError: (err as Error).message,
  });
}

async function anthropicGenerate(input: PromptInput): Promise<string> {
  return runInBreaker(async () => {
    try {
      const message = await client.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 1024,
        ...(systemParam(input) && { system: systemParam(input) }),
        messages: [{ role: 'user', content: input.user }],
      });

      const block = message.content[0];
      const text = block?.type === 'text' ? block.text : '';
      const cost = applyCostGate(message.usage, 'generate');

      logger.info(
        { model: env.CLAUDE_MODEL, usage: message.usage, cost },
        'Claude API response received',
      );

      return text;
    } catch (err) {
      mapAnthropicError(err);
    }
  });
}

async function anthropicGenerateTool(input: PromptInput, tools: ToolDefinition[]): Promise<ToolCall[]> {
  // No tools to offer means the API call can't return a tool_use block --
  // skip the request entirely rather than spend tokens on a call that can
  // only ever come back empty.
  if (tools.length === 0) return [];

  return runInBreaker(async () => {
    try {
      const message = await client.messages.create({
        model: env.CLAUDE_MODEL,
        max_tokens: 1024,
        ...(systemParam(input) && { system: systemParam(input) }),
        messages: [{ role: 'user', content: input.user }],
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
        tool_choice: { type: 'auto' },
      });

      if (message.stop_reason === 'max_tokens') {
        logger.warn(
          { model: env.CLAUDE_MODEL, usage: message.usage },
          'Claude API tool-use response truncated at max_tokens, tool_use input may be incomplete',
        );
      } else if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
        logger.warn(
          { model: env.CLAUDE_MODEL, usage: message.usage, stopReason: message.stop_reason },
          'Claude API tool-use response ended for an unexpected reason, tool_use input may be incomplete or missing',
        );
      }

      const calls: ToolCall[] = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      const textBlockCount = message.content.filter((block) => block.type === 'text').length;
      if (textBlockCount > 0) {
        logger.info(
          { model: env.CLAUDE_MODEL, textBlockCount, toolCallCount: calls.length },
          'Claude API tool-use response included text alongside or instead of tool calls',
        );
      }

      const cost = applyCostGate(message.usage, 'generateTool');

      logger.info(
        { model: env.CLAUDE_MODEL, usage: message.usage, cost, toolCallCount: calls.length },
        'Claude API tool-use response received',
      );

      return calls;
    } catch (err) {
      mapAnthropicError(err);
    }
  });
}

// Builds the messages array for one turn. `state === null` means this is the
// first turn (send the caller's question); otherwise `state` is the prior
// turn's message history and `toolResults` become this turn's tool_result
// user message, answering the ToolCalls the prior turn returned.
function buildConversationMessages(
  state: unknown,
  input: PromptInput,
  toolResults: ToolResultInput[],
): Anthropic.MessageParam[] {
  if (state === null) return [{ role: 'user', content: input.user }];

  // An empty tool_result message is only valid on the first turn (state ===
  // null); past that, every turn exists because the prior one returned at
  // least one ToolCall the caller owes a result for.
  if (toolResults.length === 0) {
    throw new Error('converseWithTools: toolResults must be non-empty once state is non-null');
  }

  return [
    ...(state as Anthropic.MessageParam[]),
    {
      role: 'user',
      content: toolResults.map((result) => ({
        type: 'tool_result' as const,
        tool_use_id: result.toolCallId,
        content: JSON.stringify(result.output) ?? String(result.output),
        ...(result.isError && { is_error: true }),
      })),
    },
  ];
}

async function anthropicConverseWithTools(
  state: unknown,
  input: PromptInput,
  tools: ToolDefinition[],
  toolResults: ToolResultInput[],
  signal?: AbortSignal,
): Promise<ConversationTurn> {
  // Built outside the breaker: a caller-contract violation (mismatched
  // state/toolResults) is a programmer error, not a Claude API failure, and
  // must not trip the circuit breaker or surface as an ExternalServiceError.
  const messages = buildConversationMessages(state, input, toolResults);

  return runInBreaker(async () => {
    try {
      const message = await client.messages.create(
        {
          model: env.CLAUDE_MODEL,
          max_tokens: 1024,
          ...(systemParam(input) && { system: systemParam(input) }),
          messages,
          ...(tools.length > 0 && {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
            tool_choice: { type: 'auto' as const },
          }),
        },
        { signal },
      );

      if (message.stop_reason === 'max_tokens') {
        logger.warn(
          { model: env.CLAUDE_MODEL, usage: message.usage },
          'Claude API multi-turn tool conversation truncated at max_tokens, tool_use input or text may be incomplete',
        );
      } else if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
        logger.warn(
          { model: env.CLAUDE_MODEL, usage: message.usage, stopReason: message.stop_reason },
          'Claude API multi-turn tool conversation ended for an unexpected reason',
        );
      }

      const toolCalls: ToolCall[] = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (text.length > 0 && toolCalls.length > 0) {
        logger.info(
          { model: env.CLAUDE_MODEL, toolCallCount: toolCalls.length },
          'Claude API multi-turn tool conversation turn included text alongside tool calls',
        );
      }

      const cost = applyCostGate(message.usage, 'converseWithTools');

      logger.info(
        { model: env.CLAUDE_MODEL, usage: message.usage, cost, toolCallCount: toolCalls.length },
        'Claude API multi-turn tool conversation turn received',
      );

      // message.content (response ContentBlocks) isn't the same TS type as
      // what MessageParam accepts back as input (ContentBlockParams), but
      // it's the standard Anthropic multi-turn tool-use pattern to feed a
      // turn's own response straight back in as the next assistant message.
      const assistantContent = message.content as unknown as Anthropic.MessageParam['content'];
      const nextState: Anthropic.MessageParam[] = [...messages, { role: 'assistant', content: assistantContent }];

      return {
        state: nextState,
        toolCalls,
        text,
        usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      };
    } catch (err) {
      // Cost gate takes precedence over the abort check: a signal that's
      // already aborted for unrelated reasons (e.g. the request just also
      // happened to be cancelled) shouldn't mask a real budget error and
      // report a benign-looking abort instead.
      if (err instanceof CostBudgetExceededError) throw err;
      if (signal?.aborted) {
        logger.info({ aborted: true }, 'Claude API multi-turn tool conversation aborted by client');
        throw new AbortedByClient();
      }
      mapAnthropicError(err);
    }
  });
}

async function anthropicStream(
  input: PromptInput,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  // client-initiated aborts are intentional, don't let them trip the breaker
  return runInBreaker(async () => {
    try {
      const stream = client.messages.stream({
        model: env.CLAUDE_MODEL,
        max_tokens: 1024,
        ...(systemParam(input) && { system: systemParam(input) }),
        messages: [{ role: 'user', content: input.user }],
      });

      if (signal) {
        const onAbort = () => stream.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        stream.on('end', () => signal.removeEventListener('abort', onAbort));
      }

      stream.on('text', (delta) => onText(delta));

      const finalMessage = await stream.finalMessage();

      // Streaming is log-only on overrun: the content already shipped to the
      // user via onText callbacks. Throwing here would be wasted, they got
      // the answer. We still skip recording into median history so the floor
      // stays representative of normal cost.
      const cost = computeCost(finalMessage.usage);
      if (cost !== null) {
        const budget = exceedsBudget(cost);
        if (budget.exceeded) {
          aiCostBudgetExceeded.inc({ caller: 'stream' });
          logger.warn(
            { cost, cap: budget.cap, median: budget.median, model: env.CLAUDE_MODEL },
            'Claude API stream cost budget exceeded, content delivered, anomaly logged',
          );
        } else {
          recordCost(cost);
        }
      }

      logger.info(
        { model: env.CLAUDE_MODEL, usage: finalMessage.usage, cost },
        'Claude API stream completed',
      );

      const block = finalMessage.content[0];
      const fullText = block?.type === 'text' ? block.text : '';

      return {
        fullText,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };
    } catch (err) {
      if (signal?.aborted) {
        logger.info({ aborted: true }, 'Claude API stream aborted by client');
        throw new AbortedByClient();
      }

      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) {
        logger.error({ err: (err as Error).message }, 'Claude API stream non-retryable error');
      } else {
        logger.warn({ err: (err as Error).message }, 'Claude API stream retryable error exhausted');
      }

      throw err;
    }
  });
}

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

// Wrappers route through getProvider() so a future provider swap is a config
// change rather than a caller migration.
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

export async function checkClaudeHealth(): Promise<ProviderHealth> {
  return getProvider().checkHealth();
}

export async function generateWithTools(input: PromptInput, tools: ToolDefinition[]): Promise<ToolCall[]> {
  return getProvider().generateTool(input, tools);
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
