import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { logger } from '../lib/logger.js';
import { AuthenticationError, ValidationError } from '../lib/appError.js';
import {
  generateOAuthState,
  buildGoogleAuthUrl,
  handleGoogleCallback,
  createTokenPair,
  rotateRefreshToken,
} from '../services/auth/index.js';
import * as refreshTokensQueries from '../db/queries/refreshTokens.js';
import { dbAdmin } from '../lib/db.js';
import { AUTH } from 'shared/constants';
import { googleCallbackSchema } from 'shared/schemas';
import { rateLimitAuth } from '../middleware/rateLimiter.js';
import { audit } from '../services/audit/auditService.js';
import { AUDIT_ACTIONS } from 'shared/constants';

const router = Router();

const isProduction = env.NODE_ENV === 'production';

function setCookie(res: Response, name: string, value: string, maxAge: number) {
  res.cookie(name, value, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAge * 1000,
  });
}

function clearCookie(res: Response, name: string) {
  res.clearCookie(name, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });
}

router.get('/auth/google', rateLimitAuth, (_req: Request, res: Response) => {
  const state = generateOAuthState();
  setCookie(res, AUTH.COOKIE_NAMES.OAUTH_STATE, state, AUTH.OAUTH_STATE_EXPIRY_SECONDS);

  const url = buildGoogleAuthUrl(state);
  res.json({ data: { url } });
});

router.post('/auth/callback', rateLimitAuth, async (req: Request, res: Response) => {
  const parsed = googleCallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid callback parameters', parsed.error.format());
  }

  const { code, state, inviteToken } = parsed.data;
  const storedState = req.cookies?.[AUTH.COOKIE_NAMES.OAUTH_STATE];

  if (!storedState || state.length !== storedState.length
      || !timingSafeEqual(Buffer.from(state), Buffer.from(storedState))) {
    throw new AuthenticationError('OAuth state mismatch — possible CSRF attack');
  }

  clearCookie(res, AUTH.COOKIE_NAMES.OAUTH_STATE);

  const { user, org, membership, isNewUser } = await handleGoogleCallback(code, inviteToken);

  const { accessToken, refreshToken } = await createTokenPair(
    user.id,
    org.id,
    membership.role as 'owner' | 'member',
    user.isPlatformAdmin,
  );

  setCookie(res, AUTH.COOKIE_NAMES.ACCESS_TOKEN, accessToken, 15 * 60);
  setCookie(res, AUTH.COOKIE_NAMES.REFRESH_TOKEN, refreshToken, 7 * 24 * 60 * 60);

  audit(req, {
    orgId: org.id,
    userId: user.id,
    action: AUDIT_ACTIONS.AUTH_LOGIN,
    metadata: { isNewUser, email: user.email },
  });

  res.json({
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
      },
      isNewUser,
    },
  });
});

router.post('/auth/refresh', rateLimitAuth, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.[AUTH.COOKIE_NAMES.REFRESH_TOKEN];
  if (!rawToken) {
    throw new AuthenticationError('Refresh token required');
  }

  const { accessToken, refreshToken } = await rotateRefreshToken(rawToken);

  setCookie(res, AUTH.COOKIE_NAMES.ACCESS_TOKEN, accessToken, 15 * 60);
  setCookie(res, AUTH.COOKIE_NAMES.REFRESH_TOKEN, refreshToken, 7 * 24 * 60 * 60);

  res.json({ data: { success: true } });
});

router.post('/auth/logout', rateLimitAuth, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.[AUTH.COOKIE_NAMES.REFRESH_TOKEN];

  if (rawToken) {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const existing = await refreshTokensQueries.findByHash(hash, dbAdmin);
    if (existing) {
      await refreshTokensQueries.revokeToken(existing.id, dbAdmin);
      audit(req, {
        orgId: existing.orgId,
        userId: existing.userId,
        action: AUDIT_ACTIONS.AUTH_LOGOUT,
      });
      logger.info({ userId: existing.userId }, 'User logged out');
    }
  }

  clearCookie(res, AUTH.COOKIE_NAMES.ACCESS_TOKEN);
  clearCookie(res, AUTH.COOKIE_NAMES.REFRESH_TOKEN);

  res.json({ data: { success: true } });
});

export default router;
