import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ── Mocks (must precede dynamic imports) ─────────────────────────

const mockGenerateOAuthState = vi.fn();
const mockBuildGoogleAuthUrl = vi.fn();
const mockHandleGoogleCallback = vi.fn();
const mockCreateTokenPair = vi.fn();
const mockRotateRefreshToken = vi.fn();
const mockFindByHash = vi.fn();
const mockRevokeToken = vi.fn();
const mockSignUpWithPassword = vi.fn();
const mockLogInWithPassword = vi.fn();
const mockRequestPasswordReset = vi.fn();
const mockResetPassword = vi.fn();
const mockSendEmail = vi.fn();

vi.mock('../services/auth/index.js', () => ({
  generateOAuthState: mockGenerateOAuthState,
  buildGoogleAuthUrl: mockBuildGoogleAuthUrl,
  handleGoogleCallback: mockHandleGoogleCallback,
  createTokenPair: mockCreateTokenPair,
  rotateRefreshToken: mockRotateRefreshToken,
  signUpWithPassword: mockSignUpWithPassword,
  logInWithPassword: mockLogInWithPassword,
  requestPasswordReset: mockRequestPasswordReset,
  resetPassword: mockResetPassword,
}));

vi.mock('../services/email/index.js', () => ({
  sendEmail: mockSendEmail,
}));

vi.mock('../db/queries/refreshTokens.js', () => ({
  findByHash: mockFindByHash,
  revokeToken: mockRevokeToken,
}));

vi.mock('../config.js', () => ({
  env: {
    NODE_ENV: 'test',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    JWT_SECRET: 'test-secret-key-that-is-at-least-32-characters',
    APP_URL: 'http://localhost:3000',
    EMAIL_MAILING_ADDRESS: '123 Test St, Testville, TS 12345',
    EMAIL_FROM_NAME: 'Tellsight',
  },
}));

vi.mock('../lib/db.js', () => ({
  db: {},
  dbAdmin: { _tag: 'dbAdmin' },
}));

vi.mock('../lib/redis.js', () => ({
  redis: { connect: vi.fn(), on: vi.fn(), ping: vi.fn() },
}));

vi.mock('../middleware/rateLimiter.js', () => ({
  rateLimitAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ── Test app setup ───────────────────────────────────────────────

const { default: authRouter } = await import('./auth.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { correlationId } = await import('../middleware/correlationId.js');

const app = express();
app.use(correlationId);
app.use(express.json());
app.use(cookieParser());
app.use(authRouter);
app.use(errorHandler);

let server: http.Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

// ── Helper ───────────────────────────────────────────────────────

function parseCookies(res: globalThis.Response): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = res.headers.getSetCookie?.() ?? [];
  for (const c of raw) {
    const pair = c.split(';')[0] ?? '';
    const eqIdx = pair.indexOf('=');
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

// ── Tests ────────────────────────────────────────────────────────

describe('auth routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /auth/google', () => {
    it('returns a Google OAuth URL and sets oauth_state cookie', async () => {
      mockGenerateOAuthState.mockReturnValue('test-state-abc');
      mockBuildGoogleAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?...');

      const res = await fetch(`${baseUrl}/auth/google`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.url).toBe('https://accounts.google.com/o/oauth2/v2/auth?...');

      const cookies = parseCookies(res);
      expect(cookies.oauth_state).toBe('test-state-abc');
    });
  });

  describe('POST /auth/callback', () => {
    it('processes valid callback and sets token cookies', async () => {
      const mockUser = {
        id: 1,
        name: 'Marcus',
        email: 'marcus@example.com',
        avatarUrl: null,
        isPlatformAdmin: false,
      };
      const mockOrg = { id: 10, name: "Marcus's Organization", slug: 'marcus-org' };

      mockHandleGoogleCallback.mockResolvedValueOnce({
        user: mockUser,
        org: mockOrg,
        membership: { role: 'owner' },
        isNewUser: true,
      });
      mockCreateTokenPair.mockResolvedValueOnce({
        accessToken: 'jwt-access-123',
        refreshToken: 'refresh-raw-456',
      });

      const res = await fetch(`${baseUrl}/auth/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'oauth_state=valid-state',
        },
        body: JSON.stringify({ code: 'google-auth-code', state: 'valid-state' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.user.email).toBe('marcus@example.com');
      expect(body.data.org.slug).toBe('marcus-org');
      expect(body.data.isNewUser).toBe(true);

      const cookies = parseCookies(res);
      expect(cookies.access_token).toBe('jwt-access-123');
      expect(cookies.refresh_token).toBe('refresh-raw-456');

      expect(mockHandleGoogleCallback).toHaveBeenCalledWith('google-auth-code', undefined);
      expect(mockCreateTokenPair).toHaveBeenCalledWith(1, 10, 'owner', false);
    });

    it('returns 401 when OAuth state does not match cookie', async () => {
      const res = await fetch(`${baseUrl}/auth/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'oauth_state=server-state',
        },
        body: JSON.stringify({ code: 'auth-code', state: 'mismatched-state' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(401);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('returns 400 when code is missing from callback body', async () => {
      const res = await fetch(`${baseUrl}/auth/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'oauth_state=test-state',
        },
        body: JSON.stringify({ state: 'test-state' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when state is missing from callback body', async () => {
      const res = await fetch(`${baseUrl}/auth/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'auth-code' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates tokens and sets new cookies', async () => {
      mockRotateRefreshToken.mockResolvedValueOnce({
        accessToken: 'new-jwt',
        refreshToken: 'new-refresh',
        userId: 1,
        orgId: 10,
      });

      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { Cookie: 'refresh_token=old-refresh-token' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);

      const cookies = parseCookies(res);
      expect(cookies.access_token).toBe('new-jwt');
      expect(cookies.refresh_token).toBe('new-refresh');

      expect(mockRotateRefreshToken).toHaveBeenCalledWith('old-refresh-token');
    });

    it('returns 401 when no refresh_token cookie is present', async () => {
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(401);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
      expect(body.error.message).toBe('Refresh token required');
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes refresh token and clears all auth cookies', async () => {
      const rawToken = 'a'.repeat(64);
      const { createHash } = await import('node:crypto');
      const expectedHash = createHash('sha256').update(rawToken).digest('hex');

      mockFindByHash.mockResolvedValueOnce({ id: 5, userId: 1 });
      mockRevokeToken.mockResolvedValueOnce({});

      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: `refresh_token=${rawToken}` },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(mockFindByHash).toHaveBeenCalledWith(expectedHash, expect.anything());
      expect(mockRevokeToken).toHaveBeenCalledWith(5, expect.anything());

      const raw = res.headers.getSetCookie?.() ?? [];
      const clearedNames = raw
        .filter((c) => c.includes('Expires=Thu, 01 Jan 1970'))
        .map((c) => c.split('=')[0]);
      expect(clearedNames).toContain('access_token');
      expect(clearedNames).toContain('refresh_token');
    });

    it('clears cookies even when no refresh token is present', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(mockFindByHash).not.toHaveBeenCalled();

      const raw = res.headers.getSetCookie?.() ?? [];
      const clearedNames = raw
        .filter((c) => c.includes('Expires=Thu, 01 Jan 1970'))
        .map((c) => c.split('=')[0]);
      expect(clearedNames).toContain('access_token');
      expect(clearedNames).toContain('refresh_token');
    });
  });

  describe('POST /auth/signup', () => {
    const mockUser = { id: 2, name: 'Dana', email: 'dana@example.com', avatarUrl: null, isPlatformAdmin: false };
    const mockOrg = { id: 20, name: "Dana's Organization", slug: 'dana-org' };

    it('creates an account and sets session cookies', async () => {
      mockSignUpWithPassword.mockResolvedValueOnce({
        user: mockUser,
        org: mockOrg,
        membership: { role: 'owner' },
        isNewUser: true,
      });
      mockCreateTokenPair.mockResolvedValueOnce({ accessToken: 'jwt-access', refreshToken: 'refresh-raw' });

      const res = await fetch(`${baseUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dana@example.com', name: 'Dana', password: 'super-secret-1' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.user.email).toBe('dana@example.com');
      expect(body.data.isNewUser).toBe(true);
      expect(mockSignUpWithPassword).toHaveBeenCalledWith('dana@example.com', 'Dana', 'super-secret-1', undefined);

      const cookies = parseCookies(res);
      expect(cookies.access_token).toBe('jwt-access');
      expect(cookies.refresh_token).toBe('refresh-raw');
    });

    it('returns 400 when the password is too short', async () => {
      const res = await fetch(`${baseUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dana@example.com', name: 'Dana', password: 'short' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(mockSignUpWithPassword).not.toHaveBeenCalled();
    });

    it('returns 409 when the email is already registered', async () => {
      const { ConflictError } = await import('../lib/appError.js');
      mockSignUpWithPassword.mockRejectedValueOnce(
        new ConflictError('An account with this email already exists. Try signing in instead.'),
      );

      const res = await fetch(`${baseUrl}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dana@example.com', name: 'Dana', password: 'super-secret-1' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(409);
      expect(body.error.code).toBe('CONFLICT');
    });
  });

  describe('POST /auth/signin', () => {
    it('authenticates and sets session cookies', async () => {
      const mockUser = { id: 3, name: 'Sam', email: 'sam@example.com', avatarUrl: null, isPlatformAdmin: false };
      const mockOrg = { id: 30, name: "Sam's Organization", slug: 'sam-org' };

      mockLogInWithPassword.mockResolvedValueOnce({
        user: mockUser,
        org: mockOrg,
        membership: { role: 'owner' },
        isNewUser: false,
      });
      mockCreateTokenPair.mockResolvedValueOnce({ accessToken: 'jwt-access', refreshToken: 'refresh-raw' });

      const res = await fetch(`${baseUrl}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sam@example.com', password: 'super-secret-1' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.user.email).toBe('sam@example.com');
      expect(body.data.isNewUser).toBe(false);

      const cookies = parseCookies(res);
      expect(cookies.access_token).toBe('jwt-access');
    });

    it('returns 401 for invalid credentials', async () => {
      const { AuthenticationError } = await import('../lib/appError.js');
      mockLogInWithPassword.mockRejectedValueOnce(new AuthenticationError('Invalid email or password'));

      const res = await fetch(`${baseUrl}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'sam@example.com', password: 'wrong-password' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(401);
      expect(body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('POST /auth/forgot-password', () => {
    it('sends a reset email when the account exists', async () => {
      mockRequestPasswordReset.mockResolvedValueOnce({ token: 'raw-reset-token', userId: 7 });
      mockSendEmail.mockResolvedValueOnce({ status: 'sent', providerMessageId: 'id-1', durationMs: 5 });

      const res = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'known@example.com' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledOnce();
      const sentArgs = mockSendEmail.mock.calls[0]![0];
      expect(sentArgs.to).toBe('known@example.com');
      expect(sentArgs.subject).toBe('Reset your password');
    });

    it('responds identically when the account does not exist, and sends no email', async () => {
      mockRequestPasswordReset.mockResolvedValueOnce(null);

      const res = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'unknown@example.com' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
      expect(mockSendEmail).not.toHaveBeenCalled();
    });

    it('still responds with success when the email provider fails, instead of leaking a 500', async () => {
      mockRequestPasswordReset.mockResolvedValueOnce({ token: 'raw-reset-token', userId: 7 });
      mockSendEmail.mockRejectedValueOnce(new Error('provider rejected recipient'));

      const res = await fetch(`${baseUrl}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'known@example.com' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.success).toBe(true);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('resets the password and signs the user in', async () => {
      const mockUser = { id: 8, name: 'Riley', email: 'riley@example.com', avatarUrl: null, isPlatformAdmin: false };
      const mockOrg = { id: 40, name: "Riley's Organization", slug: 'riley-org' };

      mockResetPassword.mockResolvedValueOnce({ user: mockUser, org: mockOrg, membership: { role: 'owner' } });
      mockCreateTokenPair.mockResolvedValueOnce({ accessToken: 'jwt-access', refreshToken: 'refresh-raw' });

      const res = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'raw-reset-token', password: 'new-super-secret' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(body.data.user.email).toBe('riley@example.com');

      const cookies = parseCookies(res);
      expect(cookies.access_token).toBe('jwt-access');
    });

    it('returns 400 when the token has expired', async () => {
      const { ValidationError } = await import('../lib/appError.js');
      mockResetPassword.mockRejectedValueOnce(new ValidationError('This reset link has expired, request a new one'));

      const res = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'expired-token', password: 'new-super-secret' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
