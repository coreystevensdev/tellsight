import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();

vi.mock('../../lib/db.js', () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (...vArgs: unknown[]) => {
          mockValues(...vArgs);
          return { returning: () => mockReturning() };
        },
      };
    },
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return {
        set: (...sArgs: unknown[]) => {
          mockSet(...sArgs);
          return {
            where: (...wArgs: unknown[]) => {
              mockUpdateWhere(...wArgs);
              return { returning: () => mockReturning() };
            },
          };
        },
      };
    },
    query: {
      shares: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock('../schema.js', () => ({
  shares: {
    id: 'id',
    orgId: 'org_id',
    tokenHash: 'token_hash',
    viewCount: 'view_count',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, strings, values }),
}));

describe('shares queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createShare', () => {
    it('inserts a share and returns the record', async () => {
      const fakeShare = { id: 1, orgId: 1, tokenHash: 'abc' };
      mockReturning.mockResolvedValue([fakeShare]);

      const { createShare } = await import('./shares.js');
      const result = await createShare(1, 2, 'abc', { orgName: 'Test' }, 5, new Date());

      expect(mockInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 1, datasetId: 2, tokenHash: 'abc', createdBy: 5 }),
      );
      expect(result).toEqual(fakeShare);
    });

    it('throws when insert returns empty', async () => {
      mockReturning.mockResolvedValue([]);

      const { createShare } = await import('./shares.js');

      await expect(createShare(1, 2, 'abc', {}, 5, new Date())).rejects.toThrow(
        'Insert failed to return share',
      );
    });
  });

  describe('findByTokenHash', () => {
    it('delegates to db.query.shares.findFirst with org relation', async () => {
      const fakeShare = { id: 1, tokenHash: 'hash123', org: { name: 'Acme' } };
      mockFindFirst.mockResolvedValue(fakeShare);

      const { findByTokenHash } = await import('./shares.js');
      const result = await findByTokenHash('hash123');

      expect(mockFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({ with: { org: true } }),
      );
      expect(result).toEqual(fakeShare);
    });

    // objectContaining({ with: ... }) says nothing about `where`, so deleting
    // the token predicate satisfied the assertion above. The real guard is
    // shares.integration.test.ts, which asks real Postgres whether a wrong token
    // returns anything; a mock cannot answer that, since it returns whatever it
    // was told to regardless of the filter.
    it('passes a where clause at all', async () => {
      mockFindFirst.mockResolvedValue({ id: 1 });

      const { findByTokenHash } = await import('./shares.js');
      await findByTokenHash('hash123');

      const arg = mockFindFirst.mock.calls[0]![0] as { where?: unknown };
      expect(arg.where, 'findFirst was called with no where clause').toBeDefined();
    });
  });

  describe('incrementViewCount', () => {
    it('atomically increments view_count and returns updated share', async () => {
      const updated = { id: 1, viewCount: 3 };
      mockReturning.mockResolvedValue([updated]);

      const { incrementViewCount } = await import('./shares.js');
      const result = await incrementViewCount(1);

      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalled();
      expect(result).toEqual(updated);
    });
  });

  describe('getSharesByOrg', () => {
    it('returns all shares for an org', async () => {
      const orgShares = [{ id: 1 }, { id: 2 }];
      mockFindMany.mockResolvedValue(orgShares);

      const { getSharesByOrg } = await import('./shares.js');
      const result = await getSharesByOrg(42);

      expect(mockFindMany).toHaveBeenCalled();
      expect(result).toEqual(orgShares);
    });
  });
});
