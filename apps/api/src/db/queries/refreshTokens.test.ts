import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindFirst = vi.fn();
const mockReturning = vi.fn();
const mockValues = vi.fn(() => ({ returning: mockReturning }));
const mockWhere = vi.fn((): unknown => ({ returning: mockReturning }));
const mockSet = vi.fn(() => ({ where: mockWhere }));

vi.mock('../../lib/db.js', () => ({
  db: {
    query: {
      refreshTokens: {
        findFirst: mockFindFirst,
      },
    },
    insert: vi.fn().mockReturnValue({ values: mockValues }),
    update: vi.fn().mockReturnValue({ set: mockSet }),
  },
}));

const { db: mockDb } = await import('../../lib/db.js');
const { createRefreshToken, findByHash, revokeToken, revokeAllForUser } = await import(
  './refreshTokens.js'
);

describe('refreshTokens queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createRefreshToken', () => {
    it('inserts a token and returns it', async () => {
      const created = { id: 1, tokenHash: 'abc123', userId: 10, orgId: 20 };
      mockReturning.mockResolvedValueOnce([created]);

      const result = await createRefreshToken({
        tokenHash: 'abc123',
        userId: 10,
        orgId: 20,
        expiresAt: new Date('2026-03-01'),
      }, mockDb);

      expect(result).toEqual(created);
    });

    it('throws if insert returns empty', async () => {
      mockReturning.mockResolvedValueOnce([]);

      await expect(
        createRefreshToken({
          tokenHash: 'abc',
          userId: 1,
          orgId: 1,
          expiresAt: new Date(),
        }, mockDb),
      ).rejects.toThrow('Insert failed to return refresh token');
    });
  });

  describe('findByHash', () => {
    it('returns a non-revoked, non-expired token', async () => {
      const token = {
        id: 1,
        tokenHash: 'abc123',
        revokedAt: null,
        expiresAt: new Date('2026-12-31'),
      };
      mockFindFirst.mockResolvedValueOnce(token);

      const result = await findByHash('abc123', mockDb);

      expect(mockFindFirst).toHaveBeenCalledOnce();
      expect(result).toEqual(token);
    });

    it('returns undefined when token not found', async () => {
      mockFindFirst.mockResolvedValueOnce(undefined);

      const result = await findByHash('nonexistent', mockDb);

      expect(result).toBeUndefined();
    });
  });

  describe('revokeToken', () => {
    it('sets revokedAt on the token', async () => {
      const revoked = { id: 1, revokedAt: new Date() };
      mockReturning.mockResolvedValueOnce([revoked]);

      const result = await revokeToken(1, mockDb);

      expect(result).toEqual(revoked);
    });

    it('returns undefined if token not found', async () => {
      mockReturning.mockResolvedValueOnce([]);

      const result = await revokeToken(999, mockDb);

      expect(result).toBeUndefined();
    });
  });

  describe('revokeAllForUser', () => {
    it('executes without error', async () => {
      mockWhere.mockResolvedValueOnce(undefined);

      await expect(revokeAllForUser(10, mockDb)).resolves.not.toThrow();
    });
  });
});
