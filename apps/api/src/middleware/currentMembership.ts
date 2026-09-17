import type { Request, Response, NextFunction } from 'express';

import { findCallerContext } from '../db/queries/userOrgs.js';
import { AuthenticationError } from '../lib/appError.js';
import { dbAdmin } from '../lib/db.js';

/**
 * Replaces the caller's standing with whatever the database says right now.
 *
 * A token carries role and isAdmin from the moment it was minted and stays valid
 * for AUTH.ACCESS_TOKEN_EXPIRY after that, and both drive real decisions:
 * roleGuard gates owner-only routes on role, and withRlsContext hands isAdmin to
 * Postgres as the RLS bypass. Trusting a fifteen-minute-old snapshot meant a
 * deleted account kept working until its token lapsed, measured on production
 * 2026-09-17: sign-in 401, refresh 401, existing access token 200.
 *
 * One indexed read on the unique (user_id, org_id) answers it instead. A missing
 * row is 401 rather than 403, because what is gone is the session's basis rather
 * than permission for one thing: the client should drop the cookie and sign in
 * again, not retry.
 */
export async function currentMembership(req: Request, _res: Response, next: NextFunction) {
  const payload = req.user;
  if (!payload) {
    throw new AuthenticationError('Missing auth context');
  }

  const current = await findCallerContext(Number(payload.sub), payload.org_id, dbAdmin);
  if (!current) {
    throw new AuthenticationError('Session no longer valid');
  }

  req.user = { ...payload, role: current.role, isAdmin: current.isPlatformAdmin };
  next();
}
