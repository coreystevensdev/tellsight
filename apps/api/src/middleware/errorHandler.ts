import type { Request, Response, NextFunction } from 'express';
import { Sentry } from '../lib/sentry.js';
import { AppError, ExternalServiceError, ProgrammerError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

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
