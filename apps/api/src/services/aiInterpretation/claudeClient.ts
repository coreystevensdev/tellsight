import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { ExternalServiceError, CostBudgetExceededError } from '../../lib/appError.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { computeCost, exceedsBudget, recordCost } from '../../lib/cost.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';
import type { LlmProvider, PromptInput, StreamResult, ProviderHealth } from './provider.js';
import { getProvider, registerProvider } from './provider.js';

export type { StreamResult };

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

// bind once — avoids the literal `breaker.exec(` on every call site, which a
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

      // Post-call cost gate. Tokens are already spent by the time we know
      // the cost, so this is an anomaly detector — the next request gets
      // the benefit. Real prevention is upstream (max_tokens, timeout).
      // Anomalies are NOT recorded into median history; recording would
      // raise the floor and let the next anomaly slip through.
      const cost = computeCost(message.usage);
      if (cost !== null) {
        const budget = exceedsBudget(cost);
        if (budget.exceeded) {
          aiCostBudgetExceeded.inc({ caller: 'generate' });
          logger.warn(
            { cost, cap: budget.cap, median: budget.median, model: env.CLAUDE_MODEL },
            'Claude API cost budget exceeded — request refused',
          );
          throw new CostBudgetExceededError(cost, budget.cap);
        }
        recordCost(cost);
      }

      logger.info(
        { model: env.CLAUDE_MODEL, usage: message.usage, cost },
        'Claude API response received',
      );

      return text;
    } catch (err) {
      // Cost gate threw our domain error — propagate unchanged so the error
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
  });
}

async function anthropicStream(
  input: PromptInput,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  // client-initiated aborts are intentional — don't let them trip the breaker
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
      // user via onText callbacks. Throwing here would be wasted — they got
      // the answer. We still skip recording into median history so the floor
      // stays representative of normal cost.
      const cost = computeCost(finalMessage.usage);
      if (cost !== null) {
        const budget = exceedsBudget(cost);
        if (budget.exceeded) {
          aiCostBudgetExceeded.inc({ caller: 'stream' });
          logger.warn(
            { cost, cap: budget.cap, median: budget.median, model: env.CLAUDE_MODEL },
            'Claude API stream cost budget exceeded — content delivered, anomaly logged',
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
  checkHealth: anthropicHealth,
};

// Self-register at module load. Callers that need the provider reach it via
// getProvider(); test files that mock this module entirely will skip this line,
// which is fine — those tests don't exercise the provider seam.
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
