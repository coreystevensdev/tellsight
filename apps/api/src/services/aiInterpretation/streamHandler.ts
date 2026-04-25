import type { Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { SseTextEvent, SseDoneEvent, SseErrorEvent, SsePartialEvent, SseUpgradeRequiredEvent, BusinessProfile } from 'shared/types';
import type { SubscriptionTier } from '../../db/queries/subscriptions.js';

import { AI_TIMEOUT_MS, FREE_PREVIEW_WORD_LIMIT, ANALYTICS_EVENTS } from 'shared/constants';
import { logger } from '../../lib/logger.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { register, deregister } from '../../lib/activeStreams.js';
import { CircuitOpenError } from '../../lib/circuitBreaker.js';
import { aiSummariesQueries } from '../../db/queries/index.js';
import { runCurationPipeline, assemblePrompt, transparencyMetadataSchema, validateSummary, validateStatRefs, stripInvalidStatRefs } from '../curation/index.js';
import type { ScoredInsight } from '../curation/index.js';
import { streamInterpretation } from './claudeClient.js';
import { trackEvent } from '../analytics/trackEvent.js';

function writeSseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function mapStreamError(err: unknown): SseErrorEvent {
  if (err instanceof CircuitOpenError) {
    return { code: 'AI_UNAVAILABLE', message: 'AI service is temporarily unavailable — try again shortly', retryable: true };
  }
  // order matters — APIConnectionTimeoutError extends APIConnectionError
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { code: 'TIMEOUT', message: 'The analysis took longer than expected', retryable: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: 'AI_UNAVAILABLE', message: 'AI service is temporarily unavailable', retryable: true };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { code: 'AI_UNAVAILABLE', message: 'AI service is temporarily unavailable', retryable: true };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { code: 'RATE_LIMITED', message: 'Too many requests', retryable: false };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { code: 'AI_AUTH_ERROR', message: 'AI service configuration error', retryable: false };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { code: 'STREAM_ERROR', message: 'Something went wrong generating insights', retryable: false };
  }
  return { code: 'STREAM_ERROR', message: 'Something went wrong generating insights', retryable: true };
}

export interface StreamOutcome {
  ok: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function streamToSSE(
  req: Request,
  res: Response,
  orgId: number,
  datasetId: number,
  userId: number,
  tier: SubscriptionTier = 'free',
  client?: typeof db | DbTransaction,
  businessProfile?: BusinessProfile | null,
): Promise<StreamOutcome> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const abortController = new AbortController();
  register(abortController);
  let accumulatedText = '';
  let timedOut = false;
  let clientDisconnected = false;
  let ended = false;
  let truncatedForFree = false;

  function safeEnd() {
    if (ended) return;
    ended = true;
    deregister(abortController);
    res.end();
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, AI_TIMEOUT_MS);

  req.on('close', () => {
    clientDisconnected = true;
    deregister(abortController);
    abortController.abort();
    clearTimeout(timeout);
  });

  // -- pipeline phase (separate catch for PIPELINE_ERROR) --
  let promptInput: { system: string; user: string };
  let validatedMetadata: ReturnType<typeof transparencyMetadataSchema.parse>;
  let promptVersion: string;
  let pipelineInsights: ScoredInsight[] = [];

  try {
    pipelineInsights = await runCurationPipeline(orgId, datasetId, client);
    const { system, user, metadata } = assemblePrompt(pipelineInsights, undefined, businessProfile);
    promptInput = { system, user };
    validatedMetadata = transparencyMetadataSchema.parse(metadata);
    promptVersion = metadata.promptVersion;
  } catch (err) {
    clearTimeout(timeout);
    if (clientDisconnected) { deregister(abortController); return { ok: false }; }
    logger.error(
      { orgId, datasetId, err: (err as Error).message },
      'curation pipeline failed',
    );
    writeSseEvent(res, 'error', {
      code: 'PIPELINE_ERROR',
      message: 'Something went wrong preparing your analysis',
      retryable: true,
    } satisfies SseErrorEvent);
    safeEnd();
    return { ok: false };
  }

  // -- stream phase --
  try {
    logger.info({ orgId, datasetId, promptVersion, tier }, 'starting AI summary stream');

    const result = await streamInterpretation(
      promptInput,
      (delta) => {
        if (clientDisconnected || ended || truncatedForFree) return;
        accumulatedText += delta;

        if (tier === 'free' && countWords(accumulatedText) >= FREE_PREVIEW_WORD_LIMIT) {
          truncatedForFree = true;
          writeSseEvent(res, 'text', { text: delta } satisfies SseTextEvent);

          const wordCount = countWords(accumulatedText);
          writeSseEvent(res, 'upgrade_required', { wordCount } satisfies SseUpgradeRequiredEvent);
          writeSseEvent(res, 'done', { usage: null, reason: 'free_preview' } satisfies SseDoneEvent);
          safeEnd();

          // stop consuming Claude tokens
          abortController.abort();
          return;
        }

        writeSseEvent(res, 'text', { text: delta } satisfies SseTextEvent);
      },
      abortController.signal,
    );

    clearTimeout(timeout);
    if (clientDisconnected) return { ok: false };

    // free-tier truncation already streamed + ended — skip caching so
    // a pro user requesting the same dataset gets a fresh full generation
    if (truncatedForFree) return { ok: true };

    if (!result.fullText) {
      logger.warn({ orgId, datasetId }, 'Claude returned empty response');
      writeSseEvent(res, 'error', {
        code: 'EMPTY_RESPONSE',
        message: 'AI produced no results',
        retryable: true,
      } satisfies SseErrorEvent);
      safeEnd();
      return { ok: false };
    }

    writeSseEvent(res, 'done', { usage: result.usage, metadata: validatedMetadata } satisfies SseDoneEvent);
    safeEnd();

    const pipelineStats = pipelineInsights.map((i) => i.stat);

    // Tier 2 chart-ref check — strip invalid <stat id="..."/> tokens before
    // they reach the cache. Live stream already shipped; clients sanitize
    // client-side via stripStatTags. The cache write below is the
    // defense-in-depth path for future cache hits.
    const refReport = validateStatRefs(result.fullText, pipelineStats);
    let cachedText = result.fullText;
    if (refReport.invalidRefs.length > 0) {
      cachedText = stripInvalidStatRefs(result.fullText, refReport.invalidRefs);
      logger.warn(
        { orgId, datasetId, invalidRefs: refReport.invalidRefs, promptVersion },
        'AI summary referenced unknown stat IDs — stripped before cache',
      );
      trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_CHART_REF_INVALID, {
        datasetId,
        tier,
        promptVersion,
        invalidRefs: refReport.invalidRefs,
        validStatIds: pipelineStats.map((s) => s.statType),
      });
    }

    // Tier 1 hallucination check — fires after stream is delivered to the user.
    // Never blocks the response; flagged summaries still cache so we have the evidence.
    const report = validateSummary(result.fullText, pipelineStats);
    if (report.status === 'clean') {
      logger.info(
        { orgId, datasetId, numbersChecked: report.numbersChecked, allowedValueCount: report.allowedValueCount },
        'AI summary validation clean',
      );
    } else {
      logger.warn(
        {
          orgId,
          datasetId,
          status: report.status,
          numbersChecked: report.numbersChecked,
          unmatched: report.unmatchedNumbers,
          promptVersion,
        },
        'AI summary validation flagged unmatched numbers',
      );
      // Analytics event lets the admin dashboard compute hallucination rates
      // (flagged / total summaries) and drill into specific incidents.
      // Cap the sample to keep the JSONB payload small.
      trackEvent(orgId, userId, ANALYTICS_EVENTS.AI_SUMMARY_VALIDATION_FLAGGED, {
        datasetId,
        tier,
        promptVersion,
        status: report.status,
        numbersChecked: report.numbersChecked,
        unmatchedCount: report.unmatchedNumbers.length,
        unmatchedSample: report.unmatchedNumbers.slice(0, 3),
      });
    }

    try {
      await aiSummariesQueries.storeSummary(
        orgId,
        datasetId,
        cachedText,
        validatedMetadata,
        promptVersion,
        false,
        client,
      );
      logger.info({ orgId, datasetId }, 'AI summary streamed and cached');
    } catch (cacheErr) {
      logger.warn(
        { orgId, datasetId, err: (cacheErr as Error).message },
        'failed to cache AI summary — stream already delivered',
      );
    }

    return { ok: true, usage: result.usage };
  } catch (err) {
    clearTimeout(timeout);

    if (clientDisconnected) {
      logger.info({ orgId, datasetId }, 'client disconnected during AI stream');
      deregister(abortController);
      return { ok: false };
    }

    // free-tier abort triggers a catch — that's expected, not an error
    if (truncatedForFree) return { ok: true };

    if (timedOut) {
      if (ended) { deregister(abortController); return { ok: false }; }

      if (accumulatedText) {
        logger.warn(
          { orgId, datasetId, partialLength: accumulatedText.length },
          'AI stream timed out — sending partial',
        );
        writeSseEvent(res, 'partial', { text: accumulatedText, metadata: validatedMetadata } satisfies SsePartialEvent);
        writeSseEvent(res, 'done', { usage: null, reason: 'timeout' } satisfies SseDoneEvent);
      } else {
        logger.warn({ orgId, datasetId }, 'AI stream timed out — no text received');
        writeSseEvent(res, 'error', {
          code: 'TIMEOUT',
          message: 'AI generation timed out',
          retryable: true,
        } satisfies SseErrorEvent);
      }

      safeEnd();
      return { ok: false };
    }

    if (ended) { deregister(abortController); return { ok: false }; }

    const mapped = mapStreamError(err);
    logger.error(
      { orgId, datasetId, errorCode: mapped.code, err: (err as Error).message },
      'AI stream error',
    );
    writeSseEvent(res, 'error', mapped);
    safeEnd();
    return { ok: false };
  }
}
