import { createHash } from 'node:crypto';

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

  // AUTH.ACCESS_TOKEN_EXPIRY was read by nothing in the suite, so shortening or
  // lengthening it was silent. Asserted through a real signed token rather than
  // against the constant, since the requirement is about the token's lifetime,
  // not about a string.
  describe('access token lifetime', () => {
    it('expires 15 minutes after issue', async () => {
      const token = await signAccessToken({ userId: 1, orgId: 10, role: 'owner', isAdmin: false });

      const claims = await verifyAccessToken(token);

      expect(claims.exp - claims.iat).toBe(15 * 60);
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

    // "both hex, and different from each other" is satisfied by reversing the
    // string. Assert the actual relationship, or the hash could stop being a
    // hash and nothing would notice. shareService.test.ts already does this.
    it('hash is the sha256 of raw', () => {
      const { raw, hash } = generateRefreshToken();

      expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
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

      // "they differ" is satisfied by swapping the two, which stores the live
      // bearer token in plaintext and hands the caller its hash. Pin the
      // relationship, not the inequality.
      expect(storedHash).toBe(createHash('sha256').update(result.refreshToken).digest('hex'));
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

    // The single-membership case above cannot tell `.find(m => m.orgId === ...)`
    // apart from `memberships[0]`, because index 0 is the match. Two memberships
    // with the token bound to the second one can. Getting this wrong hands a
    // member of org A the role they hold in some other org, on every refresh.
    it('takes the role from the membership matching the token org, not the first one', async () => {
      const existing = { id: 5, userId: 1, orgId: 20 };

      mockFindByHash.mockResolvedValueOnce(existing);
      mockRevokeToken.mockResolvedValueOnce({ ...existing, revokedAt: new Date() });
      mockFindUserById.mockResolvedValueOnce({ id: 1, isPlatformAdmin: false });
      mockGetUserOrgs.mockResolvedValueOnce([
        { orgId: 10, role: 'owner', org: { id: 10 } },
        { orgId: 20, role: 'member', org: { id: 20 } },
      ]);
      mockCreateRefreshToken.mockResolvedValueOnce({ id: 6 });

      const result = await rotateRefreshToken('a'.repeat(64));

      // Decoded, because the role only exists inside the minted token: asserting
      // on result.orgId alone passes with the wrong membership selected.
      const claims = await verifyAccessToken(result.accessToken);
      expect(claims.org_id).toBe(20);
      expect(claims.role).toBe('member');
    });

    // The empty-list case below is also satisfied by memberships[0], so it does
    // not prove the org is checked. This one has memberships that simply do not
    // include the token's org.
    it('refuses to rotate when the user belongs to other orgs but not this one', async () => {
      mockFindByHash.mockResolvedValueOnce({ id: 5, userId: 1, orgId: 99 });
      mockRevokeToken.mockResolvedValueOnce({});
      mockFindUserById.mockResolvedValueOnce({ id: 1, isPlatformAdmin: false });
      mockGetUserOrgs.mockResolvedValueOnce([{ orgId: 10, role: 'owner', org: { id: 10 } }]);

      await expect(rotateRefreshToken('a'.repeat(64))).rejects.toThrow(
        'Organization membership not found',
      );
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
