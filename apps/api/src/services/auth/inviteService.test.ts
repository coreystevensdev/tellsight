import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateInvite = vi.fn();
const mockFindByTokenHash = vi.fn();
const mockMarkUsed = vi.fn();
const mockAddMember = vi.fn();
const mockFindMembership = vi.fn();

vi.mock('../../db/queries/orgInvites.js', () => ({
  createInvite: mockCreateInvite,
  findByTokenHash: mockFindByTokenHash,
  markUsed: mockMarkUsed,
}));

vi.mock('../../db/queries/userOrgs.js', () => ({
  addMember: mockAddMember,
  findMembership: mockFindMembership,
}));

vi.mock('../../lib/db.js', () => ({
  db: {},
  dbAdmin: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { generateInvite, validateInviteToken, redeemInvite } = await import(
  './inviteService.js'
);

describe('inviteService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateInvite', () => {
    it('creates an invite and returns raw token + expiry', async () => {
      const fakeInvite = {
        id: 1,
        orgId: 10,
        expiresAt: new Date('2026-03-04T00:00:00Z'),
      };
      mockCreateInvite.mockResolvedValueOnce(fakeInvite);

      const result = await generateInvite(10, 1);

      expect(mockCreateInvite).toHaveBeenCalledOnce();
      expect(typeof result.token).toBe('string');
      // 32 bytes = 64 hex chars
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.expiresAt).toEqual(fakeInvite.expiresAt);
    });

    it('stores a hash, not the raw token', async () => {
      mockCreateInvite.mockResolvedValueOnce({
        id: 2,
        orgId: 10,
        expiresAt: new Date(),
      });

      const result = await generateInvite(10, 1);
      const storedHash = mockCreateInvite.mock.calls[0]![1];

      // the stored hash should differ from the raw token
      expect(storedHash).not.toBe(result.token);
      expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('uses custom expiry days when provided', async () => {
      mockCreateInvite.mockResolvedValueOnce({
        id: 3,
        orgId: 10,
        expiresAt: new Date('2026-04-01T00:00:00Z'),
      });

      await generateInvite(10, 1, 14);

      const passedExpiry = mockCreateInvite.mock.calls[0]![3] as Date;
      const now = new Date();
      const diffDays = Math.round(
        (passedExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(diffDays).toBeGreaterThanOrEqual(13);
      expect(diffDays).toBeLessThanOrEqual(14);
    });
  });

  describe('validateInviteToken', () => {
    it('returns the invite when token is valid', async () => {
      const validInvite = {
        id: 1,
        orgId: 10,
        usedAt: null,
        expiresAt: new Date(Date.now() + 86400000), // +1 day
        org: { id: 10, name: 'Test Org' },
      };
      mockFindByTokenHash.mockResolvedValueOnce(validInvite);

      const result = await validateInviteToken('a'.repeat(64));

      expect(result).toEqual(validInvite);
    });

    it('throws NotFoundError when token does not exist', async () => {
      mockFindByTokenHash.mockResolvedValueOnce(null);

      await expect(validateInviteToken('nonexistent')).rejects.toThrow(
        'Invite not found',
      );
    });

    it('throws ValidationError when invite is already used', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      });

      await expect(validateInviteToken('a'.repeat(64))).rejects.toThrow(
        'already been used',
      );
    });

    it('throws ValidationError when invite is expired', async () => {
      mockFindByTokenHash.mockResolvedValueOnce({
        id: 1,
        usedAt: null,
        expiresAt: new Date(Date.now() - 86400000), // -1 day
      });

      await expect(validateInviteToken('a'.repeat(64))).rejects.toThrow(
        'expired',
      );
    });
  });

  describe('redeemInvite', () => {
    it('adds member and marks invite used for a new member', async () => {
      mockFindMembership.mockResolvedValueOnce(null);
      mockAddMember.mockResolvedValueOnce({ orgId: 10, userId: 5, role: 'member' });
      mockMarkUsed.mockResolvedValueOnce({ id: 1, usedBy: 5, usedAt: new Date() });

      const result = await redeemInvite(1, 10, 5);

      expect(result.alreadyMember).toBe(false);
      expect(mockAddMember).toHaveBeenCalledWith(10, 5, 'member', expect.anything());
      expect(mockMarkUsed).toHaveBeenCalledWith(1, 5, expect.anything());
    });

    it('skips adding member when already a member (idempotent)', async () => {
      mockFindMembership.mockResolvedValueOnce({ orgId: 10, userId: 5, role: 'member' });
      mockMarkUsed.mockResolvedValueOnce({ id: 1, usedBy: 5, usedAt: new Date() });

      const result = await redeemInvite(1, 10, 5);

      expect(result.alreadyMember).toBe(true);
      expect(mockAddMember).not.toHaveBeenCalled();
      expect(mockMarkUsed).toHaveBeenCalledWith(1, 5, expect.anything());
    });
  });
});
