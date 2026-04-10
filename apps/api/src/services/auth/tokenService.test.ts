import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const mockCreateRefreshToken = vi.fn();
const mockFindByHash = vi.fn();
const mockFindAnyByHash = vi.fn();
const mockRevokeToken = vi.fn();
const mockRevokeAllForUser = vi.fn();
const mockFindUserById = vi.fn();
const mockGetUserOrgs = vi.fn();

vi.mock('../../db/queries/refreshTokens.js', () => ({
  createRefreshToken: mockCreateRefreshToken,
  findByHash: mockFindByHash,
  findAnyByHash: mockFindAnyByHash,
  revokeToken: mockRevokeToken,
  revokeAllForUser: mockRevokeAllForUser,
}));

vi.mock('../../db/queries/users.js', () => ({
  findUserById: mockFindUserById,
}));

vi.mock('../../db/queries/userOrgs.js', () => ({
  getUserOrgs: mockGetUserOrgs,
}));

vi.mock('../../lib/db.js', () => ({
  db: {},
  dbAdmin: {},
}));

vi.mock('../../config.js', () => ({
  env: {
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

const {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  createTokenPair,
  rotateRefreshToken,
} = await import('./tokenService.js');

describe('tokenService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signAccessToken', () => {
    it('returns a valid JWT string', async () => {
      const token = await signAccessToken({
        userId: 1,
        orgId: 10,
        role: 'owner',
        isAdmin: false,
      });

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('includes correct claims in the JWT', async () => {
      const token = await signAccessToken({
        userId: 42,
        orgId: 7,
        role: 'member',
        isAdmin: true,
      });

      const payload = JSON.parse(atob(token.split('.')[1]!));
      expect(payload.sub).toBe('42');
      expect(payload.org_id).toBe(7);
      expect(payload.role).toBe('member');
      expect(payload.isAdmin).toBe(true);
      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
    });
  });

  describe('verifyAccessToken', () => {
    it('verifies a valid token and returns claims', async () => {
      const token = await signAccessToken({
        userId: 1,
        orgId: 10,
        role: 'owner',
        isAdmin: false,
      });

      const claims = await verifyAccessToken(token);

      expect(claims.sub).toBe('1');
      expect(claims.org_id).toBe(10);
      expect(claims.role).toBe('owner');
      expect(claims.isAdmin).toBe(false);
    });

    it('throws AuthenticationError for invalid token', async () => {
      await expect(verifyAccessToken('invalid.token.here')).rejects.toThrow(
        'Invalid or expired access token',
      );
    });

    it('throws AuthenticationError for expired token', async () => {
      const secret = new TextEncoder().encode(
        'test-secret-key-that-is-at-least-32-characters',
      );
      const expiredToken = await new SignJWT({ org_id: 1, role: 'owner', isAdmin: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('1')
        .setExpirationTime('0s')
        .sign(secret);

      await expect(verifyAccessToken(expiredToken)).rejects.toThrow(
        'Invalid or expired access token',
      );
    });

    it('throws AuthenticationError for tampered token', async () => {
      const token = await signAccessToken({
        userId: 1,
        orgId: 10,
        role: 'owner',
        isAdmin: false,
      });

      const tampered = token.slice(0, -5) + 'XXXXX';
      await expect(verifyAccessToken(tampered)).rejects.toThrow(
        'Invalid or expired access token',
      );
    });
  });

  describe('generateRefreshToken', () => {
    it('returns raw and hash as hex strings', () => {
      const { raw, hash } = generateRefreshToken();

      expect(typeof raw).toBe('string');
      expect(typeof hash).toBe('string');
      expect(raw).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('raw and hash are different', () => {
      const { raw, hash } = generateRefreshToken();
      expect(raw).not.toBe(hash);
    });

    it('generates unique tokens each time', () => {
      const first = generateRefreshToken();
      const second = generateRefreshToken();
      expect(first.raw).not.toBe(second.raw);
      expect(first.hash).not.toBe(second.hash);
    });
  });

  describe('createTokenPair', () => {
    it('returns access token and refresh token', async () => {
      mockCreateRefreshToken.mockResolvedValueOnce({ id: 1 });

      const result = await createTokenPair(1, 10, 'owner', false);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.accessToken.split('.')).toHaveLength(3);
      expect(result.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores the hashed refresh token, not raw', async () => {
      mockCreateRefreshToken.mockResolvedValueOnce({ id: 1 });

      const result = await createTokenPair(1, 10, 'owner', false);

      expect(mockCreateRefreshToken).toHaveBeenCalledOnce();
      const storedHash = mockCreateRefreshToken.mock.calls[0]![0].tokenHash;
      expect(storedHash).not.toBe(result.refreshToken);
    });
  });

  describe('rotateRefreshToken', () => {
    it('revokes old token and creates new pair', async () => {
      const existing = { id: 5, userId: 1, orgId: 10 };
      const user = { id: 1, isPlatformAdmin: false };
      const memberships = [{ orgId: 10, role: 'owner', org: { id: 10 } }];

      mockFindByHash.mockResolvedValueOnce(existing);
      mockRevokeToken.mockResolvedValueOnce({ ...existing, revokedAt: new Date() });
      mockFindUserById.mockResolvedValueOnce(user);
      mockGetUserOrgs.mockResolvedValueOnce(memberships);
      mockCreateRefreshToken.mockResolvedValueOnce({ id: 6 });

      const result = await rotateRefreshToken('a'.repeat(64));

      expect(mockRevokeToken).toHaveBeenCalledWith(5, expect.anything());
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.userId).toBe(1);
      expect(result.orgId).toBe(10);
    });

    it('throws AuthenticationError when token not found and not revoked', async () => {
      mockFindByHash.mockResolvedValueOnce(null);
      mockFindAnyByHash.mockResolvedValueOnce(null);

      await expect(rotateRefreshToken('nonexistent')).rejects.toThrow(
        'Invalid refresh token',
      );
      expect(mockRevokeAllForUser).not.toHaveBeenCalled();
    });

    it('revokes all user tokens when a revoked token is replayed (reuse detection)', async () => {
      mockFindByHash.mockResolvedValueOnce(null);
      mockFindAnyByHash.mockResolvedValueOnce({
        id: 5,
        userId: 42,
        orgId: 10,
        revokedAt: new Date(),
      });
      mockRevokeAllForUser.mockResolvedValueOnce(undefined);

      await expect(rotateRefreshToken('a'.repeat(64))).rejects.toThrow(
        'Invalid refresh token',
      );
      expect(mockRevokeAllForUser).toHaveBeenCalledWith(42, expect.anything());
    });

    it('throws AuthenticationError when user not found', async () => {
      mockFindByHash.mockResolvedValueOnce({ id: 5, userId: 999, orgId: 10 });
      mockRevokeToken.mockResolvedValueOnce({});
      mockFindUserById.mockResolvedValueOnce(null);

      await expect(rotateRefreshToken('a'.repeat(64))).rejects.toThrow('User not found');
    });

    it('throws AuthenticationError when membership not found', async () => {
      mockFindByHash.mockResolvedValueOnce({ id: 5, userId: 1, orgId: 10 });
      mockRevokeToken.mockResolvedValueOnce({});
      mockFindUserById.mockResolvedValueOnce({ id: 1, isPlatformAdmin: false });
      mockGetUserOrgs.mockResolvedValueOnce([]);

      await expect(rotateRefreshToken('a'.repeat(64))).rejects.toThrow(
        'Organization membership not found',
      );
    });
  });
});
