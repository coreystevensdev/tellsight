import { Router } from 'express';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { AuthenticationError, ValidationError } from '../lib/appError.js';
import {
  generateOAuthState,
  buildGoogleAuthUrl,
  handleGoogleCallback,
  createTokenPair,
  rotateRefreshToken,
  signUpWithPassword,
  logInWithPassword,
  requestPasswordReset,
  resetPassword,
} from '../services/auth/index.js';
import { PasswordResetEmail } from '../services/auth/templates/passwordResetEmail.js';
import { sendEmail } from '../services/email/index.js';
import * as refreshTokensQueries from '../db/queries/refreshTokens.js';
import { dbAdmin } from '../lib/db.js';
import { sessionCookieOptions, clearCookieOptions } from '../lib/cookies.js';
import { env } from '../config.js';
import { AUTH, PASSWORD_RESET } from 'shared/constants';
import { googleCallbackSchema, signupSchema, passwordLoginSchema, forgotPasswordSchema, resetPasswordSchema } from 'shared/schemas';
import { rateLimitAuth } from '../middleware/rateLimiter.js';
import { audit } from '../services/audit/auditService.js';
import { AUDIT_ACTIONS } from 'shared/constants';

const router = Router();

function setCookie(res: Response, name: string, value: string, maxAge: number) {
  res.cookie(name, value, sessionCookieOptions(maxAge));
}

function clearCookie(res: Response, name: string) {
  res.clearCookie(name, clearCookieOptions());
}

interface SessionSubject {
  user: { id: number; name: string; email: string; avatarUrl: string | null; isPlatformAdmin: boolean };
  org: { id: number; name: string; slug: string };
  membership: { role: string };
  isNewUser: boolean;
}

/** Shared by every route that ends in an authenticated session (OAuth
 * callback, signup, password login, password reset): issue a token pair,
 * set the session cookies, and respond with the same session shape. */
async function respondWithSession(req: Request, res: Response, subject: SessionSubject) {
  const { user, org, membership, isNewUser } = subject;

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
    action: isNewUser ? AUDIT_ACTIONS.AUTH_SIGNUP : AUDIT_ACTIONS.AUTH_LOGIN,
    metadata: { isNewUser, email: user.email },
  });

  res.json({
    data: {
      user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
      org: { id: org.id, name: org.name, slug: org.slug },
      isNewUser,
    },
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
    throw new AuthenticationError('OAuth state mismatch, possible CSRF attack');
  }

  clearCookie(res, AUTH.COOKIE_NAMES.OAUTH_STATE);

  const subject = await handleGoogleCallback(code, inviteToken);
  await respondWithSession(req, res, subject);
});

router.post('/auth/signup', rateLimitAuth, async (req: Request, res: Response) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid sign-up parameters', parsed.error.format());
  }

  const { email, name, password, inviteToken } = parsed.data;
  const subject = await signUpWithPassword(email, name, password, inviteToken);
  await respondWithSession(req, res, subject);
});

router.post('/auth/signin', rateLimitAuth, async (req: Request, res: Response) => {
  const parsed = passwordLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid sign-in parameters', parsed.error.format());
  }

  const { email, password } = parsed.data;
  const subject = await logInWithPassword(email, password);
  await respondWithSession(req, res, subject);
});

router.post('/auth/forgot-password', rateLimitAuth, async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid request', parsed.error.format());
  }

  const result = await requestPasswordReset(parsed.data.email);

  // sends only on a real match, but the response is identical either way,
  // including on a provider failure, so this endpoint can't be used to
  // check which emails have an account
  if (result) {
    const resetUrl = `${env.APP_URL}/reset-password?token=${result.token}`;
    try {
      await sendEmail({
        to: parsed.data.email,
        subject: 'Reset your password',
        react: PasswordResetEmail({
          resetUrl,
          expiryHours: PASSWORD_RESET.EXPIRY_HOURS,
          mailingAddress: env.EMAIL_MAILING_ADDRESS,
          companyName: env.EMAIL_FROM_NAME,
        }),
      });
      audit(req, {
        orgId: null,
        userId: result.userId,
        action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
      });
    } catch (err) {
      logger.error({ err, userId: result.userId }, 'Failed to send password reset email');
    }
  }

  res.json({ data: { success: true } });
});

router.post('/auth/reset-password', rateLimitAuth, async (req: Request, res: Response) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ValidationError('Invalid request', parsed.error.format());
  }

  const { token, password } = parsed.data;
  const { user, org, membership } = await resetPassword(token, password);

  audit(req, {
    orgId: org.id,
    userId: user.id,
    action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_COMPLETED,
  });

  await respondWithSession(req, res, { user, org, membership, isNewUser: false });
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
