import type { Request, Response, NextFunction } from 'express';
import { AUTH } from 'shared/constants';
import { verifyAccessToken } from '../services/auth/tokens.js';
import { AuthenticationError } from '../lib/appError.js';

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
