import type { Request } from 'express';
import type { JwtPayload } from 'shared/types';
import { AuthenticationError } from './appError.js';

/** Returns the authenticated user from req, or throws if auth middleware
 *  didn't run (e.g., route mounted on the public router by mistake). */
export function requireUser(req: Request): JwtPayload {
  if (!req.user) {
    throw new AuthenticationError('Missing authenticated user on request');
  }
  return req.user;
}
