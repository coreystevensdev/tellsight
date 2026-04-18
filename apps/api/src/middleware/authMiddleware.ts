import type { Request, Response, NextFunction } from 'express';
import { AUTH } from 'shared/constants';
import type { JwtPayload } from 'shared/types';
import { verifyAccessToken } from '../services/auth/tokenService.js';
import { AuthenticationError } from '../lib/appError.js';

// Retained for callers that want a request type where user is guaranteed.
// Post-augmentation, most call sites just use `requireUser(req)` or
// `req.user` directly — no cast needed.
export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[AUTH.COOKIE_NAMES.ACCESS_TOKEN];
  if (!token) {
    throw new AuthenticationError('Missing access token');
  }

  // verifyAccessToken throws AuthenticationError on invalid/expired tokens
  const payload = await verifyAccessToken(token);
  req.user = payload;
  next();
}
