import type { Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import type { SseDoneEvent, SseErrorEvent, SsePartialEvent, BusinessProfile } from 'shared/types';
import type { SubscriptionTier } from '../../db/queries/subscriptions.js';

import { logger } from '../../lib/logger.js';
import type { db, DbTransaction } from '../../lib/db.js';
import { aiSummaryDuration } from '../../lib/metrics.js';
import { CircuitOpenError } from '../../lib/circuitBreaker.js';
import { streamInterpretation } from './claudeClient.js';
import { finalizeStreamSummary } from './finalizeStreamSummary.js';
import { prepareStreamPrompt } from './prepareStreamPrompt.js';
import { StreamSession } from './streamSession.js';
import { StreamTextPolicy } from './streamTextPolicy.js';

function writeSseEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mapStreamError(err: unknown): SseErrorEvent {
  if (err instanceof CircuitOpenError) {
    return { code: 'AI_UNAVAILABLE', message: 'AI service is temporarily unavailable, try again shortly', retryable: true };
  }
  // order matters, APIConnectionTimeoutError extends APIConnectionError
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
    return { code: 'STREAM_ERROR', message: 'Request rejected by AI service', retryable: false };
  }
  return { code: 'STREAM_ERROR', message: 'AI stream failed', retryable: true };
}

export interface StreamOutcome {
  ok: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  clientDisconnected?: boolean;
}

export async function streamToSSE(
  res: Response,
  orgId: number,
  datasetId: number,
  userId: number,
  tier: SubscriptionTier = 'free',
  client?: typeof db | DbTransaction,
  businessProfile?: BusinessProfile | null,
): Promise<StreamOutcome> {
  // A caller can already have consumed this connection's 'close' event before
  // reaching here (aiSummary.ts's rate-limit wait listens via res.once('close', ...)),
  // and Node never replays a past event to a listener registered after it fired.
  // qa.ts avoids this by registering its listener before any async gates; this
  // function runs after aiSummary.ts's gates, so res.destroyed is the only way
  // left to catch that disconnect.
  if (res.destroyed) {
    logger.info({ orgId, datasetId }, 'client disconnected before AI stream started');
    return { ok: false, clientDisconnected: true };
  }

  const session = new StreamSession(res);
  let prepared: Awaited<ReturnType<typeof prepareStreamPrompt>>;

  try {
    prepared = await prepareStreamPrompt(orgId, datasetId, client, businessProfile);
  } catch (err) {
    session.clearDeadline();
    if (session.clientDisconnected) {
      session.deregister();
      return { ok: false, clientDisconnected: true };
    }
    logger.error(
      { orgId, datasetId, err: (err as Error).message },
      'curation pipeline failed',
    );
    writeSseEvent(res, 'error', {
      code: 'PIPELINE_ERROR',
      message: 'Failed to prepare data for analysis',
      retryable: true,
    } satisfies SseErrorEvent);
    session.end();
    return { ok: false };
  }

  const { promptInput, validatedMetadata, promptVersion, pipelineInsights } = prepared;

  const streamStart = Date.now();
  const textPolicy = new StreamTextPolicy(
    tier,
    streamStart,
    session,
    (event, data) => writeSseEvent(res, event, data),
  );

  try {
    logger.info({ orgId, datasetId, promptVersion, tier }, 'starting AI summary stream');

    const result = await streamInterpretation(
      promptInput,
      (delta) => textPolicy.handleDelta(delta),
      session.signal,
    );

    session.clearDeadline();
    if (session.clientDisconnected) return { ok: false, clientDisconnected: true };

    // free-tier truncation already streamed + ended, skip caching so
    // a pro user requesting the same dataset gets a fresh full generation
    if (textPolicy.truncated) return { ok: true };

    if (!result.fullText) {
      logger.warn({ orgId, datasetId }, 'Claude returned empty response');
      writeSseEvent(res, 'error', {
        code: 'EMPTY_RESPONSE',
        message: 'AI produced no results',
        retryable: true,
      } satisfies SseErrorEvent);
      session.end();
      return { ok: false };
    }

    writeSseEvent(res, 'done', { usage: result.usage, metadata: validatedMetadata } satisfies SseDoneEvent);
    aiSummaryDuration.observe({ tier, outcome: 'complete' }, (Date.now() - streamStart) / 1000);
    session.end();

    await finalizeStreamSummary({
      orgId,
      datasetId,
      userId,
      tier,
      promptVersion,
      fullText: result.fullText,
      pipelineInsights,
      metadata: validatedMetadata,
      client,
    });

    return { ok: true, usage: result.usage };
  } catch (err) {
    session.clearDeadline();

    if (session.clientDisconnected) {
      logger.info({ orgId, datasetId }, 'client disconnected during AI stream');
      session.deregister();
      return { ok: false, clientDisconnected: true };
    }

    // free-tier abort triggers a catch, that's expected, not an error
    if (textPolicy.truncated) return { ok: true };

    if (session.timedOut) {
      if (session.ended) {
        session.deregister();
        return { ok: false };
      }

      if (textPolicy.text) {
        logger.warn(
          { orgId, datasetId, partialLength: textPolicy.text.length },
          'AI stream timed out, sending partial',
        );
        writeSseEvent(res, 'partial', { text: textPolicy.text, metadata: validatedMetadata } satisfies SsePartialEvent);
        writeSseEvent(res, 'done', { usage: null, reason: 'timeout' } satisfies SseDoneEvent);
      } else {
        logger.warn({ orgId, datasetId }, 'AI stream timed out, no text received');
        writeSseEvent(res, 'error', {
          code: 'TIMEOUT',
          message: 'AI generation timed out',
          retryable: true,
        } satisfies SseErrorEvent);
      }

      session.end();
      return { ok: false };
    }

    if (session.ended) {
      session.deregister();
      return { ok: false };
    }

    const mapped = mapStreamError(err);
    logger.error(
      { orgId, datasetId, errorCode: mapped.code, err: (err as Error).message },
      'AI stream error',
    );
    writeSseEvent(res, 'error', mapped);
    session.end();
    return { ok: false };
  }
}
