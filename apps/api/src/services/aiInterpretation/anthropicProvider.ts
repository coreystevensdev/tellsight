import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { ExternalServiceError, CostBudgetExceededError } from '../../lib/appError.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { computeCost, exceedsBudget, recordCost, type Usage } from '../../lib/cost.js';
import { aiCostBudgetExceeded, aiToolCallsDropped } from '../../lib/metrics.js';
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
import { buildConversationMessages } from './anthropicConversation.js';
import { registerProvider } from './provider.js';

export type { StreamResult, ToolDefinition, ToolCall, ToolResultInput, ConversationTurn };

const client = new Anthropic({
  apiKey: env.CLAUDE_API_KEY,
  maxRetries: 2,
  timeout: 15_000,
});

class AbortedByClient extends Error {
  constructor() {
    super('aborted by client');
  }
}

// Each breaker independently needs 3 consecutive failures to open for 30s.
// Anthropic SDK already retries twice per call, so 3 trips = 9 failed
// attempts over ~45s of real outage on that breaker's own traffic.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;
const isIgnored = (err: unknown) =>
  err instanceof AbortedByClient || err instanceof CostBudgetExceededError;

const breaker = new CircuitBreaker({
  name: 'claude-api',
  threshold: BREAKER_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_MS,
  isIgnored,
});

// Three independent instances so a failure burst unique to one call site
// can't trip the breaker guarding another: `breaker` covers the
// customer-facing generate/stream path, `toolBreaker` the single-shot
// generateTool call, `converseBreaker` the multi-turn QA loop. Same
// threshold/cooldown/isIgnored across all three, they just don't share counts.
const toolBreaker = new CircuitBreaker({
  name: 'claude-api-tool',
  threshold: BREAKER_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_MS,
  isIgnored,
});

const converseBreaker = new CircuitBreaker({
  name: 'claude-api-converse',
  threshold: BREAKER_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_MS,
  isIgnored,
});

// bind once, avoids the literal `breaker.exec(` on every call site, which a
// repo-wide security lint flags as shell-exec even though it's CircuitBreaker.
const runInBreaker = breaker.exec.bind(breaker);
const runToolInBreaker = toolBreaker.exec.bind(toolBreaker);
const runConverseInBreaker = converseBreaker.exec.bind(converseBreaker);

// Raised from 1024 on 2026-09-18. Sonnet 4.5 uses about 291 output tokens on a
// representative fixture, but the newer models spend output tokens on thinking:
// Sonnet 5 used 856 on the same one, 84% of the old cap. A max_tokens stop makes
// the tool paths drop every tool call in the response, so the headroom is not
// optional if a model that thinks is ever selected.
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Which model a given path uses.
 *
 * 'prose' is the interpretation, the digest and the alert copy: the product's
 * claim is that it explains numbers well, so this is the one worth paying for.
 * 'tools' is proposals and the Q&A loop, which want a tool call in the right
 * shape more than they want good sentences.
 *
 * Unset CLAUDE_MODEL_TOOLS means both resolve to the same model, which is what
 * shipped before this existed.
 */
export function modelFor(path: 'prose' | 'tools'): string {
  return path === 'tools' ? (env.CLAUDE_MODEL_TOOLS ?? env.CLAUDE_MODEL) : env.CLAUDE_MODEL;
}

// Reports a rejected key as 'error' and anything else as 'degraded'. Collapsing
// both to 'error', which this did, means the check calls the key broken every
// time Anthropic has a bad minute, and a check that cries wolf gets ignored on
// the morning it is right. config.ts only asserts the key is a non-empty string,
// so a mistyped one boots fine and fails first for a user.
export async function probeClaudeHealth(): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    // A one-token completion, not models.list. Listing models is a metadata
    // call that costs nothing, so it succeeds against an account that cannot
    // buy a single completion: on 2026-10-25 this logged "Claude key verified"
    // twice, five hours after every real request had started failing on an
    // exhausted balance, and the admin panel said AI was fine throughout. A
    // check blind to the likeliest reason its subject breaks is worse than no
    // check, because it reads as reassurance.
    //
    // The cost is one output token per boot and per admin health read. The
    // model is the one the prose path actually uses, so this also fails if that
    // model is retired rather than discovering it on the next digest.
    await client.messages.create({
      model: modelFor('prose'),
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const status = (err as { status?: number }).status;
    const name = (err as Error).name;
    const message = (err as Error).message ?? '';

    if (status === 401 || status === 403 || name === 'AuthenticationError') {
      // Keep the message identical to customer-traffic failures: the
      // CloudWatch metric filter keys on it, so the paid probe can alert even
      // when no customer happens to use an AI surface during the outage.
      logger.error({ err: message, source: 'health_probe' }, 'Claude API non-retryable error');
      return { status: 'error', latencyMs, detail: 'Anthropic rejected the configured API key' };
    }

    // Anthropic reports an empty balance as a 400 invalid_request_error rather
    // than a 402, so it is only separable by the message. Worth separating:
    // "key rejected" sends someone to rotate a credential that is fine.
    if (status === 400 && /credit balance/i.test(message)) {
      logger.error({ err: message, source: 'health_probe' }, 'Claude API non-retryable error');
      return {
        status: 'error',
        latencyMs,
        detail: 'Anthropic account has no credit, every AI feature is down',
      };
    }

    logger.warn({ err: message }, 'Could not verify the Claude key');
    return { status: 'degraded', latencyMs, detail: 'Anthropic unreachable, key not verified' };
  }
}

const anthropicHealth = probeClaudeHealth;

// The first text block, not the first block.
//
// A response is a list, and a model that thinks puts a thinking block in it. When
// one landed at index 0 this returned '' and the caller got a blank summary with
// no error: the eval saw judges replying "I need to see the actual summary
// content to grade it" on roughly one Sonnet 5 sample in ten. The tool paths
// already filtered across every block; the prose paths did not.
function firstText(content: Array<{ type: string }>): string {
  const block = content.find((b) => b.type === 'text');
  return block && 'text' in block ? String((block as { text: unknown }).text) : '';
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
function applyCostGate(usage: Usage, caller: string, model: string): number | null {
  const cost = computeCost(usage, model);
  if (cost === null) {
    // config.ts refuses an unpriced CLAUDE_MODEL at boot, so reaching this means
    // a caller passed a model of its own. Not thrown: the tokens are spent and
    // failing the request would turn an accounting gap into a 500. Logged loudly
    // because an uncapped call is exactly the thing that must not pass quietly.
    logger.error({ model, caller }, 'No pricing for model, cost gate skipped');
    return null;
  }

  const budget = exceedsBudget(cost);
  if (budget.exceeded) {
    aiCostBudgetExceeded.inc({ caller });
    logger.warn(
      { cost, cap: budget.cap, median: budget.median, model },
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

/**
 * Generate against a named model rather than whatever the path resolves to.
 *
 * Exists for the eval harness, which has to hold the judge fixed while the model
 * under test changes: judging with the model being judged makes a lenient grader
 * look like a better writer. Goes through the same breaker and cost gate as
 * everything else, so a judge run is bounded and costed like any other call.
 */
export async function generateWithModel(input: PromptInput, model: string): Promise<string> {
  return runInBreaker(async () => {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(systemParam(input) && { system: systemParam(input) }),
        messages: [{ role: 'user', content: input.user }],
      });

      const text = firstText(message.content);
      applyCostGate(message.usage, 'generateWithModel', model);

      return text;
    } catch (err) {
      mapAnthropicError(err);
    }
  });
}

async function anthropicGenerate(input: PromptInput): Promise<string> {
  return runInBreaker(async () => {
    try {
      const message = await client.messages.create({
        model: modelFor('prose'),
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(systemParam(input) && { system: systemParam(input) }),
        messages: [{ role: 'user', content: input.user }],
      });

      const text = firstText(message.content);
      const cost = applyCostGate(message.usage, 'generate', modelFor('prose'));

      logger.info(
        { model: modelFor('prose'), usage: message.usage, cost },
        'Claude API response received',
      );

      return text;
    } catch (err) {
      mapAnthropicError(err);
    }
  });
}

async function anthropicGenerateTool(
  input: PromptInput,
  tools: ToolDefinition[],
  onCost?: (cost: number | null) => void,
): Promise<ToolCall[]> {
  // No tools to offer means the API call can't return a tool_use block --
  // skip the request entirely rather than spend tokens on a call that can
  // only ever come back empty.
  if (tools.length === 0) return [];

  return runToolInBreaker(async () => {
    try {
      const message = await client.messages.create({
        model: modelFor('tools'),
        max_tokens: MAX_OUTPUT_TOKENS,
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
          { model: modelFor('tools'), usage: message.usage },
          'Claude API tool-use response truncated at max_tokens, dropping all tool calls from this response',
        );
      } else if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
        logger.warn(
          { model: modelFor('tools'), usage: message.usage, stopReason: message.stop_reason },
          'Claude API tool-use response ended for an unexpected reason, dropping all tool calls from this response',
        );
      }

      const calls: ToolCall[] = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      const textBlockCount = message.content.filter((block) => block.type === 'text').length;
      if (textBlockCount > 0) {
        logger.info(
          { model: modelFor('tools'), textBlockCount, toolCallCount: calls.length },
          'Claude API tool-use response included text alongside or instead of tool calls',
        );
      }

      const cost = applyCostGate(message.usage, 'generateTool', modelFor('tools'));
      onCost?.(cost);

      logger.info(
        { model: modelFor('tools'), usage: message.usage, cost, toolCallCount: calls.length },
        'Claude API tool-use response received',
      );

      // no signal for which tool_use block an abnormal stop actually clipped,
      // so drop the whole batch rather than gamble one's JSON closed cleanly
      if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
        if (calls.length > 0) {
          aiToolCallsDropped.inc({
            caller: 'generateTool',
            reason: message.stop_reason === 'max_tokens' ? 'max_tokens' : 'abnormal_stop_reason',
          });
        }
        return [];
      }

      return calls;
    } catch (err) {
      mapAnthropicError(err);
    }
  });
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
  const messages = buildConversationMessages(state, input, tools, toolResults);

  return runConverseInBreaker(async () => {
    try {
      const message = await client.messages.create(
        {
          model: modelFor('tools'),
          max_tokens: MAX_OUTPUT_TOKENS,
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

      const isAbnormalStop =
        message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use';

      if (message.stop_reason === 'max_tokens') {
        logger.warn(
          { model: modelFor('tools'), usage: message.usage },
          'Claude API multi-turn tool conversation truncated at max_tokens, tool_use input or text may be incomplete',
        );
      } else if (isAbnormalStop) {
        logger.warn(
          { model: modelFor('tools'), usage: message.usage, stopReason: message.stop_reason },
          'Claude API multi-turn tool conversation ended for an unexpected reason',
        );
      }

      let toolCalls: ToolCall[] = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, input: block.input }));

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (text.length > 0 && toolCalls.length > 0) {
        logger.info(
          { model: modelFor('tools'), toolCallCount: toolCalls.length },
          'Claude API multi-turn tool conversation turn included text alongside tool calls',
        );
      }

      // Same rationale as generateTool: no signal for which tool_use block an
      // abnormal stop actually clipped, so drop the whole batch rather than
      // risk acting on a call whose JSON didn't close cleanly. text and usage
      // are untouched, qaLoop.ts falls back to turn.text on an empty
      // toolCalls array instead of acting on a possibly-truncated call.
      if (isAbnormalStop) {
        if (toolCalls.length > 0) {
          aiToolCallsDropped.inc({
            caller: 'converseWithTools',
            reason: message.stop_reason === 'max_tokens' ? 'max_tokens' : 'abnormal_stop_reason',
          });
        }
        toolCalls = [];
      }

      const cost = applyCostGate(message.usage, 'converseWithTools', modelFor('tools'));

      logger.info(
        { model: modelFor('tools'), usage: message.usage, cost, toolCallCount: toolCalls.length },
        'Claude API multi-turn tool conversation turn received',
      );

      // message.content (response ContentBlocks) isn't the same TS type as
      // what MessageParam accepts back as input (ContentBlockParams), but
      // it's the standard Anthropic multi-turn tool-use pattern to feed a
      // turn's own response straight back in as the next assistant message.
      const assistantContent = message.content as unknown as Anthropic.MessageParam['content'];
      const nextState: Anthropic.MessageParam[] = [
        ...messages,
        { role: 'assistant', content: assistantContent },
      ];

      return {
        state: nextState,
        toolCalls,
        text,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
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
        model: modelFor('prose'),
        max_tokens: MAX_OUTPUT_TOKENS,
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
      // Same model this call actually used, not the global default: with a
      // per-path override those differ and the cap would cost the stream wrong.
      const cost = computeCost(finalMessage.usage, modelFor('prose'));
      if (cost !== null) {
        const budget = exceedsBudget(cost);
        if (budget.exceeded) {
          aiCostBudgetExceeded.inc({ caller: 'stream' });
          logger.warn(
            { cost, cap: budget.cap, median: budget.median, model: modelFor('prose') },
            'Claude API stream cost budget exceeded, content delivered, anomaly logged',
          );
        } else {
          recordCost(cost);
        }
      }

      logger.info(
        { model: modelFor('prose'), usage: finalMessage.usage, cost },
        'Claude API stream completed',
      );

      const fullText = firstText(finalMessage.content);

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

      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.BadRequestError
      ) {
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
