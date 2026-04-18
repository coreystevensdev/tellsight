import type { Request, Response, NextFunction } from 'express';
import { AuthenticationError, AuthorizationError } from '../lib/appError.js';

type GuardRole = 'owner' | 'member' | 'admin';

export function roleGuard(requiredRole: GuardRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const { user } = req;

    // safety net — roleGuard must run after authMiddleware
    if (!user) {
      throw new AuthenticationError('Missing auth context');
    }

    if (requiredRole === 'admin') {
      if (!user.isAdmin) {
        throw new AuthorizationError('Platform admin access required');
      }
      return next();
    }

    if (requiredRole === 'owner') {
      if (user.role !== 'owner') {
        throw new AuthorizationError('Owner access required');
      }
      return next();
    }

    // 'member' — any authenticated user passes (owner or member)
    next();
  };
}
