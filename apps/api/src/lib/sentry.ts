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
 *
 * org_id and role go to tags (not user custom fields) so the Sentry UI
 * can filter/group errors by them — e.g., "show me all errors from
 * members only" or "group by org_id." User fields aren't searchable
 * that way by default.
 */
export function sentryUserContext(req: Request, _res: Response, next: NextFunction) {
  const user = req.user;
  if (user) {
    Sentry.setUser({ id: user.sub });
    Sentry.setTag('org_id', String(user.org_id));
    Sentry.setTag('role', user.role);
    if (user.isAdmin) Sentry.setTag('platform_admin', 'true');
  }
  next();
}

export { Sentry };
export { setupExpressErrorHandler } from '@sentry/node';
