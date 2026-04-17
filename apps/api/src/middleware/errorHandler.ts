import type { Request, Response, NextFunction } from 'express';
import { Sentry } from '../lib/sentry.js';
import { AppError, ExternalServiceError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    // ExternalServiceErrors (Stripe down, Claude timeout) are worth tracking
    if (err instanceof ExternalServiceError) {
      Sentry.captureException(err, {
        level: 'warning',
        extra: { code: err.code, statusCode: err.statusCode },
      });
    }

    log.warn({ err, statusCode: err.statusCode }, err.message);

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

  // unhandled errors — these are real bugs
  Sentry.captureException(err);
  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
