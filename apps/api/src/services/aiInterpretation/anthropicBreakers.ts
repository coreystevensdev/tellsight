import { CostBudgetExceededError } from '../../lib/appError.js';
import { CircuitBreaker } from '../../lib/circuitBreaker.js';
import { AbortedByClient } from './anthropicProviderSupport.js';

export type BreakerRunner = <T>(operation: () => Promise<T>) => Promise<T>;

export interface AnthropicBreakerRunners {
  runProse: BreakerRunner;
  runTool: BreakerRunner;
  runConverse: BreakerRunner;
}

// Anthropic retries twice inside each SDK call. Three consecutive breaker
// failures therefore represent roughly nine failed attempts before a 30s pause.
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

const isIgnored = (err: unknown) =>
  err instanceof AbortedByClient || err instanceof CostBudgetExceededError;

function createRunner(name: string): BreakerRunner {
  const breaker = new CircuitBreaker({
    name,
    threshold: BREAKER_THRESHOLD,
    cooldownMs: BREAKER_COOLDOWN_MS,
    isIgnored,
  });
  return breaker.exec.bind(breaker);
}

/**
 * Keeps failure counts independent across customer prose/stream traffic,
 * single-shot tool generation, and multi-turn conversations.
 */
export function createAnthropicBreakerRunners(): AnthropicBreakerRunners {
  return {
    runProse: createRunner('claude-api'),
    runTool: createRunner('claude-api-tool'),
    runConverse: createRunner('claude-api-converse'),
  };
}
