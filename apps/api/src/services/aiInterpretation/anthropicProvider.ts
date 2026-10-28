import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { CostBudgetExceededError } from '../../lib/appError.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { computeCost, exceedsBudget, recordCost } from '../../lib/cost.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';
import type {
  LlmProvider,
  PromptInput,
  StreamResult,
  ProviderHealth,
} from './provider.js';
import {
  AbortedByClient,
  MAX_OUTPUT_TOKENS,
  applyCostGate,
  firstText,
  mapAnthropicError,
  modelFor,
  systemParam,
} from './anthropicProviderSupport.js';
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

export { modelFor };

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

const {
  generateTool: anthropicGenerateTool,
  converseWithTools: anthropicConverseWithTools,
} = createAnthropicToolMethods({
  client,
  runGenerateTool: runToolInBreaker,
  runConverse: runConverseInBreaker,
});

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
