import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUserByEmail = vi.fn();
const mockFindUserById = vi.fn();
const mockCreateUser = vi.fn();
const mockUpdateUser = vi.fn();
const mockGetUserOrgs = vi.fn();
const mockFindMembership = vi.fn();
const mockCreateToken = vi.fn();
const mockFindByTokenHash = vi.fn();
const mockMarkUsed = vi.fn();
const mockRevokeAllForUser = vi.fn();
const mockValidateInviteToken = vi.fn();
const mockRedeemInvite = vi.fn();
const mockCreateOwnerOrgForUser = vi.fn();
const mockHashPassword = vi.fn();
const mockVerifyPassword = vi.fn();

vi.mock('../../db/queries/users.js', () => ({
  findUserByEmail: mockFindUserByEmail,
  findUserById: mockFindUserById,
  createUser: mockCreateUser,
  updateUser: mockUpdateUser,
}));

vi.mock('../../db/queries/userOrgs.js', () => ({
  getUserOrgs: mockGetUserOrgs,
  findMembership: mockFindMembership,
}));

vi.mock('../../db/queries/passwordResetTokens.js', () => ({
  createToken: mockCreateToken,
  findByTokenHash: mockFindByTokenHash,
  markUsed: mockMarkUsed,
}));

vi.mock('../../db/queries/refreshTokens.js', () => ({
  revokeAllForUser: mockRevokeAllForUser,
}));

vi.mock('./inviteService.js', () => ({
  validateInviteToken: mockValidateInviteToken,
  redeemInvite: mockRedeemInvite,
}));

vi.mock('./orgOnboarding.js', () => ({
  createOwnerOrgForUser: mockCreateOwnerOrgForUser,
}));

vi.mock('./passwordService.js', () => ({
  hashPassword: mockHashPassword,
  verifyPassword: mockVerifyPassword,
}));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: { _tag: 'dbAdmin' },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  signUpWithPassword,
  logInWithPassword,
  requestPasswordReset,
  resetPassword,
} = await import('./passwordAuth.js');
const { ConflictError, AuthenticationError, NotFoundError, ValidationError } = await import('../../lib/appError.js');

describe('passwordAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signUpWithPassword', () => {
    it('rejects an email that is already registered', async () => {
      mockFindUserByEmail.mockResolvedValueOnce({ id: 1, email: 'taken@example.com' });

      await expect(signUpWithPassword('taken@example.com', 'Name', 'password123')).rejects.toBeInstanceOf(
        ConflictError,
      );
      expect(mockCreateUser).not.toHaveBeenCalled();
    });

    it('creates a user, hashes the password, and creates an owner org', async () => {
      mockFindUserByEmail.mockResolvedValueOnce(undefined);
      mockHashPassword.mockResolvedValueOnce('hashed:pw');
      mockCreateUser.mockResolvedValueOnce({ id: 5, email: 'new@example.com', name: 'New' });
      mockCreateOwnerOrgForUser.mockResolvedValueOnce({
        org: { id: 50, name: "New's Organization", slug: 'new-org' },
        membership: { role: 'owner' },
      });

      const result = await signUpWithPassword('new@example.com', 'New', 'password123');

      expect(mockHashPassword).toHaveBeenCalledWith('password123');
      expect(mockCreateUser).toHaveBeenCalledWith({
        email: 'new@example.com',
        name: 'New',
        passwordHash: 'hashed:pw',
      });
      expect(result.isNewUser).toBe(true);
      expect(result.org.slug).toBe('new-org');
    });

    it('joins the invite org instead of creating a new one when an invite token is given', async () => {
      mockFindUserByEmail.mockResolvedValueOnce(undefined);
      mockValidateInviteToken.mockResolvedValueOnce({ id: 9, orgId: 90, org: { id: 90, name: 'Team', slug: 'team' } });
      mockHashPassword.mockResolvedValueOnce('hashed:pw');
      mockCreateUser.mockResolvedValueOnce({ id: 6, email: 'joiner@example.com', name: 'Joiner' });
      mockFindMembership.mockResolvedValueOnce({ role: 'member' });

      const result = await signUpWithPassword('joiner@example.com', 'Joiner', 'password123', 'raw-invite-token');

      expect(mockRedeemInvite).toHaveBeenCalledWith(9, 90, 6);
      expect(mockCreateOwnerOrgForUser).not.toHaveBeenCalled();
      expect(result.org.slug).toBe('team');
    });
  });

  describe('logInWithPassword', () => {
    it('rejects when no user matches the email', async () => {
      mockFindUserByEmail.mockResolvedValueOnce(undefined);

      await expect(logInWithPassword('nobody@example.com', 'password123')).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it('rejects a Google-only account with no password set', async () => {
      mockFindUserByEmail.mockResolvedValueOnce({ id: 1, email: 'google@example.com', passwordHash: null });

      await expect(logInWithPassword('google@example.com', 'password123')).rejects.toBeInstanceOf(
        AuthenticationError,
      );
      expect(mockVerifyPassword).not.toHaveBeenCalled();
    });

    it('rejects an incorrect password', async () => {
      mockFindUserByEmail.mockResolvedValueOnce({ id: 1, email: 'user@example.com', passwordHash: 'hashed:pw' });
      mockVerifyPassword.mockResolvedValueOnce(false);

      await expect(logInWithPassword('user@example.com', 'wrong')).rejects.toBeInstanceOf(AuthenticationError);
    });

    it('logs in with the correct password', async () => {
      mockFindUserByEmail.mockResolvedValueOnce({ id: 1, email: 'user@example.com', passwordHash: 'hashed:pw' });
      mockVerifyPassword.mockResolvedValueOnce(true);
      mockGetUserOrgs.mockResolvedValueOnce([{ org: { id: 10, name: 'Org', slug: 'org' }, role: 'owner' }]);

      const result = await logInWithPassword('user@example.com', 'correct');
      expect(result.isNewUser).toBe(false);
      expect(result.org.slug).toBe('org');
    });
  });

  describe('requestPasswordReset', () => {
    it('returns null without creating a token for an unknown email', async () => {
      mockFindUserByEmail.mockResolvedValueOnce(undefined);

      const result = await requestPasswordReset('unknown@example.com');
      expect(result).toBeNull();
      expect(mockCreateToken).not.toHaveBeenCalled();
    });

    it('creates a token for a known email', async () => {
      mockFindUserByEmail.mockResolvedValueOnce({ id: 7, email: 'known@example.com' });
      mockCreateToken.mockResolvedValueOnce({ id: 1 });

      const result = await requestPasswordReset('known@example.com');
      expect(result?.userId).toBe(7);
      expect(mockCreateToken).toHaveBeenCalledOnce();
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown token', async () => {
      mockFindByTokenHash.mockResolvedValueOnce(undefined);

      await expect(resetPassword('bad-token', 'newpassword1')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects an already-used token', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        userId: 7,
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(resetPassword('used-token', 'newpassword1')).rejects.toBeInstanceOf(ValidationError);
    });

    it('rejects an expired token', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        userId: 7,
        usedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(resetPassword('expired-token', 'newpassword1')).rejects.toBeInstanceOf(ValidationError);
    });

    it('resets the password, revokes existing sessions, and marks the token used', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        userId: 7,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      mockFindUserById.mockResolvedValueOnce({ id: 7, email: 'user@example.com' });
      mockHashPassword.mockResolvedValueOnce('hashed:new');
      mockGetUserOrgs.mockResolvedValueOnce([{ org: { id: 10, name: 'Org', slug: 'org' }, role: 'owner' }]);

      const result = await resetPassword('valid-token', 'newpassword1');

      expect(mockUpdateUser).toHaveBeenCalledWith(7, { passwordHash: 'hashed:new' });
      expect(mockMarkUsed).toHaveBeenCalledWith(1, expect.anything());
      expect(mockRevokeAllForUser).toHaveBeenCalledWith(7, expect.anything());
      expect(result.org.slug).toBe('org');
    });
  });
});
