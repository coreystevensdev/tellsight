import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUserByGoogleId = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockCreateOrg = vi.fn();
const mockFindOrgBySlug = vi.fn();
const mockAddMember = vi.fn();
const mockGetUserOrgs = vi.fn();

vi.mock('../../db/queries/users.js', () => ({
  findUserByGoogleId: mockFindUserByGoogleId,
  createUser: mockCreateUser,
  updateUser: mockUpdateUser,
}));

vi.mock('../../db/queries/orgs.js', () => ({
  createOrg: mockCreateOrg,
  findOrgBySlug: mockFindOrgBySlug,
}));

vi.mock('../../db/queries/userOrgs.js', () => ({
  addMember: mockAddMember,
  getUserOrgs: mockGetUserOrgs,
}));

vi.mock('../../lib/db.js', () => ({
  db: {},
  dbAdmin: {},
}));

vi.mock('../../config.js', () => ({
  env: {
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    APP_URL: 'http://localhost:3000',
    JWT_SECRET: 'test-secret-key-that-is-at-least-32-characters',
    NODE_ENV: 'test',
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock jose's createRemoteJWKSet and jwtVerify for Google ID token verification
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

const { buildGoogleAuthUrl, generateOAuthState, handleGoogleCallback } = await import(
  './googleOAuth.js'
);

// Get the mocked jose module for dynamic return values
const jose = await import('jose');
const mockJwtVerify = vi.mocked(jose.jwtVerify);

// Mock global fetch for Google token exchange
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('googleOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateOAuthState', () => {
    it('returns a 32-character hex string', () => {
      const state = generateOAuthState();
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique states', () => {
      const state1 = generateOAuthState();
      const state2 = generateOAuthState();
      expect(state1).not.toBe(state2);
    });
  });

  describe('buildGoogleAuthUrl', () => {
    it('returns a valid Google OAuth URL', () => {
      const url = buildGoogleAuthUrl('test-state');

      expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url).toContain('client_id=test-client-id.apps.googleusercontent.com');
      expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback');
      expect(url).toContain('response_type=code');
      expect(url).toContain('scope=openid+email+profile');
      expect(url).toContain('state=test-state');
    });

    it('includes access_type=offline for refresh capability', () => {
      const url = buildGoogleAuthUrl('test-state');
      expect(url).toContain('access_type=offline');
    });
  });

  describe('handleGoogleCallback', () => {
    const mockGoogleProfile = {
      sub: 'google-123',
      email: 'marcus@example.com',
      name: 'Marcus Rivera',
      picture: 'https://example.com/photo.jpg',
    };

    function setupGoogleTokenExchange() {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id_token: 'mock-id-token',
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      mockJwtVerify.mockResolvedValueOnce({
        payload: mockGoogleProfile,
        protectedHeader: { alg: 'RS256' },
      } as never);
    }

    it('creates new user with auto-created org for first-time sign-in', async () => {
      setupGoogleTokenExchange();

      mockFindUserByGoogleId.mockResolvedValueOnce(null); // Not found
      mockCreateUser.mockResolvedValueOnce({
        id: 1,
        email: 'marcus@example.com',
        name: 'Marcus Rivera',
        googleId: 'google-123',
        avatarUrl: 'https://example.com/photo.jpg',
        isPlatformAdmin: false,
      });
      mockFindOrgBySlug.mockResolvedValueOnce(null); // Slug available
      mockCreateOrg.mockResolvedValueOnce({
        id: 10,
        name: "Marcus Rivera's Organization",
        slug: 'marcus-rivera-org',
      });
      mockAddMember.mockResolvedValueOnce({
        id: 1,
        userId: 1,
        orgId: 10,
        role: 'owner',
      });

      const result = await handleGoogleCallback('auth-code');

      expect(result.isNewUser).toBe(true);
      expect(result.user.id).toBe(1);
      expect(result.org.slug).toBe('marcus-rivera-org');
      expect(mockCreateUser).toHaveBeenCalledWith({
        email: 'marcus@example.com',
        name: 'Marcus Rivera',
        googleId: 'google-123',
        avatarUrl: 'https://example.com/photo.jpg',
      });
      expect(mockAddMember).toHaveBeenCalledWith(10, 1, 'owner', expect.anything());
    });

    it('returns existing user without creating duplicate org', async () => {
      setupGoogleTokenExchange();

      const existingUser = {
        id: 1,
        email: 'marcus@example.com',
        name: 'Marcus Rivera',
        googleId: 'google-123',
        isPlatformAdmin: false,
      };
      mockFindUserByGoogleId.mockResolvedValueOnce(existingUser);
      mockUpdateUser.mockResolvedValueOnce(existingUser);
      mockGetUserOrgs.mockResolvedValueOnce([
        {
          orgId: 10,
          role: 'owner',
          org: { id: 10, name: "Marcus Rivera's Organization", slug: 'marcus-rivera-org' },
        },
      ]);

      const result = await handleGoogleCallback('auth-code');

      expect(result.isNewUser).toBe(false);
      expect(result.user.id).toBe(1);
      expect(mockCreateUser).not.toHaveBeenCalled();
      expect(mockCreateOrg).not.toHaveBeenCalled();
    });

    it('retries slug generation on collision', async () => {
      setupGoogleTokenExchange();

      mockFindUserByGoogleId.mockResolvedValueOnce(null);
      mockCreateUser.mockResolvedValueOnce({
        id: 2,
        email: 'marcus@example.com',
        name: 'Marcus Rivera',
        googleId: 'google-456',
        avatarUrl: null,
        isPlatformAdmin: false,
      });

      // First slug taken, second slug available
      mockFindOrgBySlug
        .mockResolvedValueOnce({ id: 99 }) // "marcus-rivera-org" taken
        .mockResolvedValueOnce(null); // "marcus-rivera-org-XXXX" available

      mockCreateOrg.mockResolvedValueOnce({
        id: 11,
        name: "Marcus Rivera's Organization",
        slug: 'marcus-rivera-org-a1b2',
      });
      mockAddMember.mockResolvedValueOnce({
        id: 2,
        userId: 2,
        orgId: 11,
        role: 'owner',
      });

      const result = await handleGoogleCallback('auth-code');

      expect(result.isNewUser).toBe(true);
      expect(mockFindOrgBySlug).toHaveBeenCalledTimes(2);
    });

    it('throws ExternalServiceError when Google token exchange fails', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Bad Request',
      });

      await expect(handleGoogleCallback('bad-code')).rejects.toThrow(
        'External service error: Google OAuth',
      );
    });

    it('throws AuthenticationError when user has no org membership', async () => {
      setupGoogleTokenExchange();

      mockFindUserByGoogleId.mockResolvedValueOnce({
        id: 1,
        email: 'orphan@example.com',
        isPlatformAdmin: false,
      });
      mockUpdateUser.mockResolvedValueOnce({});
      mockGetUserOrgs.mockResolvedValueOnce([]);

      await expect(handleGoogleCallback('auth-code')).rejects.toThrow(
        'User has no organization membership',
      );
    });
  });
});
