import type { Request, Response, NextFunction } from 'express';
import { Sentry } from '../lib/sentry.js';
import { AppError, ExternalServiceError, ProgrammerError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

// Only the types a caller can actually provoke. Anything else from body-parser
// is still treated as a bug and kept loud.
const BODY_PARSER_CODES: Record<string, string> = {
  'entity.parse.failed': 'INVALID_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
};

const BODY_PARSER_MESSAGES: Record<string, string> = {
  INVALID_JSON: 'Request body is not valid JSON.',
  PAYLOAD_TOO_LARGE: 'Request body is too large.',
};

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    // ProgrammerErrors are real bugs, treat them like unhandled errors at the
    // logging + telemetry layer, but still route through the AppError branch
    // so the response shape stays consistent.
    //
    // devMessage is used as the log title and the Sentry fingerprint so that
    // distinct invariants group as distinct issues. Using err.message would
    // collapse every ProgrammerError into one issue titled with the generic
    // client-facing text.
    if (err instanceof ProgrammerError) {
      Sentry.captureException(err, {
        level: 'error',
        fingerprint: ['programmer-error', err.devMessage],
        extra: { code: err.code },
      });
      log.error({ err, code: err.code }, err.devMessage);
    } else {
      // ExternalServiceErrors (Stripe down, Claude timeout) are worth tracking.
      // Fingerprint by service so Stripe and Claude issues don't collapse into
      // one Sentry issue, same pattern as ProgrammerError above.
      if (err instanceof ExternalServiceError) {
        Sentry.captureException(err, {
          level: 'warning',
          fingerprint: ['external-service', err.service],
          extra: { code: err.code, statusCode: err.statusCode, service: err.service },
        });
      }
      log.warn({ err, statusCode: err.statusCode }, err.message);
    }

    const safeDetails = err instanceof ExternalServiceError ? undefined : err.details;

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(safeDetails !== undefined && { details: safeDetails }),
      },
    });
    return;
  }

  // body-parser rejects a malformed or oversized body before any route runs, so
  // these never reach a handler and never become AppErrors. They were falling
  // through to the branch below: a client posting `"nope"` got a 500 saying the
  // server had a problem, and every one of them woke Sentry. Both are the
  // caller's mistake, and body-parser already worked out the right status.
  const parseFailure = err as Error & { type?: string; status?: number; statusCode?: number };
  const clientCode = BODY_PARSER_CODES[parseFailure.type ?? ''];
  if (clientCode) {
    const status = parseFailure.status ?? parseFailure.statusCode ?? 400;
    log.warn({ err, type: parseFailure.type, statusCode: status }, 'Malformed request body');

    res.status(status).json({
      error: { code: clientCode, message: BODY_PARSER_MESSAGES[clientCode]! },
    });
    return;
  }

  // unhandled errors, these are real bugs
  Sentry.captureException(err);
  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
