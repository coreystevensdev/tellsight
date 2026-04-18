import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockOffset = vi.fn();

const insertChain = { values: mockValues };
const valuesChain = { returning: mockReturning };

mockInsert.mockReturnValue(insertChain);
mockValues.mockReturnValue(valuesChain);

const selectChain = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  offset: mockOffset,
};

for (const fn of Object.values(selectChain)) {
  fn.mockReturnValue(selectChain);
}

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {
    insert: mockInsert,
    select: mockSelect,
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ['eq', ...args]),
  and: vi.fn((...conditions: unknown[]) => ['and', ...conditions]),
  gte: vi.fn((...args: unknown[]) => ['gte', ...args]),
  lte: vi.fn((...args: unknown[]) => ['lte', ...args]),
  desc: vi.fn((col: unknown) => ['desc', col]),
  count: vi.fn(() => 'count'),
}));

vi.mock('../schema.js', () => ({
  auditLogs: {
    id: 'al.id', orgId: 'al.orgId', userId: 'al.userId',
    action: 'al.action', targetType: 'al.targetType', targetId: 'al.targetId',
    metadata: 'al.metadata', ipAddress: 'al.ipAddress', userAgent: 'al.userAgent',
    createdAt: 'al.createdAt',
  },
  orgs: { id: 'orgs.id', name: 'orgs.name' },
  users: { id: 'users.id', email: 'users.email', name: 'users.name' },
}));

beforeEach(() => vi.clearAllMocks());

const { record, query, total } = await import('./auditLogs.js');

describe('auditLogs queries', () => {
  describe('record', () => {
    it('inserts an audit entry and returns it', async () => {
      const fakeRow = { id: 1, action: 'auth.login', createdAt: new Date() };
      mockReturning.mockResolvedValueOnce([fakeRow]);

      const result = await record({
        orgId: 10,
        userId: 5,
        action: 'auth.login',
        ipAddress: '192.168.1.1',
        userAgent: 'TestBrowser',
      });

      expect(result).toEqual(fakeRow);
      expect(mockInsert).toHaveBeenCalled();
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 10,
          userId: 5,
          action: 'auth.login',
          ipAddress: '192.168.1.1',
          userAgent: 'TestBrowser',
        }),
      );
    });

    it('sets optional fields to null when not provided', async () => {
      mockReturning.mockResolvedValueOnce([{ id: 2 }]);

      await record({ orgId: null, userId: null, action: 'system.startup' });

      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: null,
          userId: null,
          targetType: null,
          targetId: null,
          metadata: null,
          ipAddress: null,
          userAgent: null,
        }),
      );
    });
  });

  describe('query', () => {
    it('calls select chain with defaults', async () => {
      mockOffset.mockResolvedValueOnce([]);

      await query({});

      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockOffset).toHaveBeenCalledWith(0);
    });

    it('passes custom limit and offset', async () => {
      mockOffset.mockResolvedValueOnce([]);

      await query({ limit: 25, offset: 100 });

      expect(mockLimit).toHaveBeenCalledWith(25);
      expect(mockOffset).toHaveBeenCalledWith(100);
    });

    it('applies action filter when provided', async () => {
      mockOffset.mockResolvedValueOnce([]);

      await query({ action: 'auth.login' });

      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe('total', () => {
    it('returns count value', async () => {
      mockWhere.mockResolvedValueOnce([{ value: 42 }]);

      const result = await total({});

      expect(result).toBe(42);
    });

    it('returns 0 when no rows', async () => {
      mockWhere.mockResolvedValueOnce([]);

      const result = await total({});

      expect(result).toBe(0);
    });
  });
});
