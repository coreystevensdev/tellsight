import Anthropic from '@anthropic-ai/sdk';

import { computeCost, exceedsBudget, recordCost } from '../../lib/cost.js';
import { logger } from '../../lib/logger.js';
import { aiCostBudgetExceeded } from '../../lib/metrics.js';
import type { BreakerRunner } from './anthropicBreakers.js';
import {
  AbortedByClient,
  MAX_OUTPUT_TOKENS,
  firstText,
  modelFor,
  systemParam,
} from './anthropicProviderSupport.js';
import type { LlmProvider } from './provider.js';

interface AnthropicStreamDependencies {
  client: Anthropic;
  runInBreaker: BreakerRunner;
}

export function createAnthropicStream({
  client,
  runInBreaker,
}: AnthropicStreamDependencies): LlmProvider['stream'] {
  return async function stream(input, onText, signal) {
    // Client-initiated aborts are intentional and must not trip the breaker.
    return runInBreaker(async () => {
      try {
        const model = modelFor('prose');
        const sdkStream = client.messages.stream({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(systemParam(input) && { system: systemParam(input) }),
          messages: [{ role: 'user', content: input.user }],
        });

        if (signal) {
          const onAbort = () => sdkStream.abort();
          signal.addEventListener('abort', onAbort, { once: true });
          sdkStream.on('end', () => signal.removeEventListener('abort', onAbort));
        }

        sdkStream.on('text', (delta) => onText(delta));
        const finalMessage = await sdkStream.finalMessage();

        // An overrun is log-only because content has already reached the user.
        // Keep anomalous spend out of median history so the floor remains useful.
        const cost = computeCost(finalMessage.usage, model);
        if (cost !== null) {
          const budget = exceedsBudget(cost);
          if (budget.exceeded) {
            aiCostBudgetExceeded.inc({ caller: 'stream' });
            logger.warn(
              { cost, cap: budget.cap, median: budget.median, model },
              'Claude API stream cost budget exceeded, content delivered, anomaly logged',
            );
          } else {
            recordCost(cost);
          }
        }

        logger.info({ model, usage: finalMessage.usage, cost }, 'Claude API stream completed');

        return {
          fullText: firstText(finalMessage.content),
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
          logger.warn(
            { err: (err as Error).message },
            'Claude API stream retryable error exhausted',
          );
        }

        throw err;
      }
    });
  };
}
