import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../../lib/logger.js';
import type { BreakerRunner } from './anthropicBreakers.js';
import {
  MAX_OUTPUT_TOKENS,
  applyCostGate,
  firstText,
  mapAnthropicError,
  modelFor,
  systemParam,
} from './anthropicProviderSupport.js';
import type { LlmProvider, PromptInput } from './provider.js';

interface AnthropicProseDependencies {
  client: Anthropic;
  runInBreaker: BreakerRunner;
}

interface AnthropicProseMethods {
  generate: LlmProvider['generate'];
  generateWithModel(input: PromptInput, model: string): Promise<string>;
}

export function createAnthropicProseMethods({
  client,
  runInBreaker,
}: AnthropicProseDependencies): AnthropicProseMethods {
  async function generateWithModel(input: PromptInput, model: string): Promise<string> {
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

  async function generate(input: PromptInput): Promise<string> {
    return runInBreaker(async () => {
      try {
        const model = modelFor('prose');
        const message = await client.messages.create({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(systemParam(input) && { system: systemParam(input) }),
          messages: [{ role: 'user', content: input.user }],
        });

        const text = firstText(message.content);
        const cost = applyCostGate(message.usage, 'generate', model);

        logger.info({ model, usage: message.usage, cost }, 'Claude API response received');
        return text;
      } catch (err) {
        mapAnthropicError(err);
      }
    });
  }

  return { generate, generateWithModel };
}
