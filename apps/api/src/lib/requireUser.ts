import type { Request } from 'express';
import type { JwtPayload } from 'shared/types';
import { ProgrammerError } from './appError.js';

/** Returns the authenticated user from req, or throws if auth middleware
 *  didn't run (e.g., route mounted on the public router by mistake).
 *
 *  Throws ProgrammerError (500), not AuthenticationError (401), a missing
 *  user post-middleware means server misconfiguration, not a failed login.
 *  Using 401 here would send a "reauthenticate" signal to a client that's
 *  already authenticated, creating a broken retry loop. */
export function requireUser(req: Request): JwtPayload {
  if (!req.user) {
    throw new ProgrammerError('requireUser called without authMiddleware, route misconfigured');
  }
  return req.user;
}
