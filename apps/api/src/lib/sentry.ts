import * as Sentry from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';

import { env } from '../config.js';

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.2 : 1.0,
    beforeSend(event) {
      // strip cookies and auth headers from error reports
      if (event.request?.headers) {
        delete event.request.headers.cookie;
        delete event.request.headers.authorization;
      }
      return event;
    },
  });
}

/**
 * Sets Sentry user context from the JWT payload so errors
 * are associated with the user + org that triggered them.
 * Mount after authMiddleware on protected routes.
 */
export function sentryUserContext(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  if (user) {
    Sentry.setUser({
      id: user.sub,
      org_id: String(user.org_id),
      role: user.role,
    });
  }
  next();
}

export { Sentry };
export { setupExpressErrorHandler } from '@sentry/node';
