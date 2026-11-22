import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../../lib/logger.js';
import { modelFor } from './anthropicRequest.js';
import { isCreditExhausted, NO_CREDIT_DETAIL } from './claudeObservedHealth.js';
import type { ProviderHealth } from './provider.js';

export function createAnthropicHealthProbe(client: Anthropic): () => Promise<ProviderHealth> {
  return async function probeAnthropicHealth(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      // A paid completion verifies both credentials and billing. models.list
      // can succeed against an account that cannot buy a completion.
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
        // This message drives the CloudWatch metric filter for customer traffic
        // and health probes alike.
        logger.error({ err: message, source: 'health_probe' }, 'Claude API non-retryable error');
        return { status: 'error', latencyMs, detail: 'Anthropic rejected the configured API key' };
      }

      if (isCreditExhausted(err)) {
        logger.error({ err: message, source: 'health_probe' }, 'Claude API non-retryable error');
        return { status: 'error', latencyMs, detail: NO_CREDIT_DETAIL };
      }

      logger.warn({ err: message }, 'Could not verify the Claude key');
      return { status: 'degraded', latencyMs, detail: 'Anthropic unreachable, key not verified' };
    }
  };
}
