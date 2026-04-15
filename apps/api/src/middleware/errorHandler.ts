import type { Request, Response, NextFunction } from 'express';
import { AppError, ExternalServiceError } from '../lib/appError.js';
import { logger } from '../lib/logger.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    log.warn({ err, statusCode: err.statusCode }, err.message);

    // don't leak internal service details (Stripe/Claude errors) to clients
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

  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
