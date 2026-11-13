import type Anthropic from '@anthropic-ai/sdk';

import { logger } from '../../lib/logger.js';
import type { BreakerRunner } from './anthropicBreakers.js';
import { MAX_OUTPUT_TOKENS, modelFor, singleTurnPrompt, toolParams } from './anthropicRequest.js';
import { applyCostGate, mapAnthropicError } from './anthropicRuntime.js';
import {
  countTextBlocks,
  extractToolCalls,
  retainCompleteToolCalls,
} from './anthropicToolResponse.js';
import type { LlmProvider } from './provider.js';

interface GenerateToolDependencies {
  client: Anthropic;
  runInBreaker: BreakerRunner;
}

// The tool path's own timeout, kept off the shared client so the streaming
// path's 15s is untouched. See the call site for why 30s and why it is bounded
// by EVALUATE_ORG_LOCK_DURATION_MS rather than picked.
const TOOL_REQUEST_TIMEOUT_MS = 30_000;

export function createAnthropicGenerateTool({
  client,
  runInBreaker,
}: GenerateToolDependencies): LlmProvider['generateTool'] {
  return async function generateTool(input, tools, onCost) {
    if (tools.length === 0) return [];

    return runInBreaker(async () => {
      try {
        const model = modelFor('tools');
        const startedAt = Date.now();
        const message = await client.messages.create(
          {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            ...singleTurnPrompt(input),
            tools: toolParams(tools),
            tool_choice: { type: 'auto' },
          },
          // Per-request, so the shared client's 15s stays where its reasoning
          // applies: AI_TIMEOUT_MS is commented "15s total, TTFT < 2s" and is
          // about a user watching a stream. This path is a background job
          // (jobs/agentOrchestrator), so nobody is waiting on a first token.
          //
          // 15s stopped being enough once the agent started finding more: 1.67
          // proposals a sample against 1.00, and more output takes longer to
          // generate. 27 of 36 samples timed out where the same fixture had
          // previously timed out none (DW-269).
          //
          // 30s is bounded by the job, not chosen freely. workers.ts sizes
          // EVALUATE_ORG_LOCK_DURATION_MS at 180s and notes this call "can burn
          // up to 45s across attempts" at 15s with maxRetries 2; at 30s the
          // worst case is 90s, still inside the lock with room for the DB work
          // that comment says is uncounted. seed.ts uses the same value for the
          // same off-hot-path reason.
          { timeout: TOOL_REQUEST_TIMEOUT_MS },
        );
        const durationMs = Date.now() - startedAt;

        if (message.stop_reason === 'max_tokens') {
          logger.warn(
            { model, usage: message.usage },
            'Claude API tool-use response truncated at max_tokens, dropping all tool calls from this response',
          );
        } else if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'tool_use') {
          logger.warn(
            { model, usage: message.usage, stopReason: message.stop_reason },
            'Claude API tool-use response ended for an unexpected reason, dropping all tool calls from this response',
          );
        }

        // Logged because nothing did, which is why the timeout above had to be
        // argued from a job lock rather than measured. A run of these says what
        // the path actually needs.
        logger.info(
          { model, durationMs, outputTokens: message.usage?.output_tokens },
          'Claude API tool-use response complete',
        );

        const calls = extractToolCalls(message.content);
        const textBlockCount = countTextBlocks(message.content);
        if (textBlockCount > 0) {
          logger.info(
            { model, textBlockCount, toolCallCount: calls.length },
            'Claude API tool-use response included text alongside or instead of tool calls',
          );
        }

        const cost = applyCostGate(message.usage, 'generateTool', model);
        onCost?.(cost);

        logger.info(
          { model, usage: message.usage, cost, toolCallCount: calls.length },
          'Claude API tool-use response received',
        );
        return retainCompleteToolCalls(calls, message.stop_reason, 'generateTool');
      } catch (err) {
        mapAnthropicError(err);
      }
    });
  };
}
