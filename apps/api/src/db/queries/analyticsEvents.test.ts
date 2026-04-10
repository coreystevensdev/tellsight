import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockOffset = vi.fn();

const chainable = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  offset: mockOffset,
};

for (const fn of Object.values(chainable)) {
  fn.mockReturnValue(chainable);
}

vi.mock('../../lib/db.js', () => ({
  db: { select: mockSelect },
  dbAdmin: { select: mockSelect },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ['eq', ...args]),
  desc: vi.fn((col: unknown) => ['desc', col]),
  and: vi.fn((...conditions: unknown[]) => ['and', ...conditions]),
  gte: vi.fn((...args: unknown[]) => ['gte', ...args]),
  lte: vi.fn((...args: unknown[]) => ['lte', ...args]),
  count: vi.fn(() => 'count'),
  sql: Object.assign(
    (strings: TemplateStringsArray, ..._exprs: unknown[]) => strings.join(''),
    { raw: (s: string) => s },
  ),
}));

vi.mock('../schema.js', () => ({
  analyticsEvents: {
    id: 'ae.id', orgId: 'ae.orgId', userId: 'ae.userId',
    eventName: 'ae.eventName', metadata: 'ae.metadata', createdAt: 'ae.createdAt',
  },
  orgs: { id: 'orgs.id', name: 'orgs.name' },
  users: { id: 'users.id', email: 'users.email', name: 'users.name' },
}));

beforeEach(() => vi.clearAllMocks());

describe('analyticsEvents queries', () => {
  describe('getAllAnalyticsEvents', () => {
    it('returns events with org name and user email', async () => {
      const fakeEvents = [
        {
          id: 1, eventName: 'user.signed_in', orgName: 'Acme', userEmail: 'a@b.com',
          userName: 'Alice', metadata: null, createdAt: new Date('2026-03-01'),
        },
      ];
      mockOffset.mockResolvedValueOnce(fakeEvents);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      const result = await getAllAnalyticsEvents({});

      expect(result).toEqual(fakeEvents);
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockInnerJoin).toHaveBeenCalledTimes(2);
    });

    it('applies eventName filter', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({ eventName: 'user.signed_in' });

      expect(mockWhere).toHaveBeenCalled();
    });

    it('applies orgId filter', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({ orgId: 5 });

      expect(mockWhere).toHaveBeenCalled();
    });

    it('applies date range filters', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
      });

      expect(mockWhere).toHaveBeenCalled();
    });

    it('respects custom limit and offset', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({ limit: 25, offset: 50 });

      expect(mockLimit).toHaveBeenCalledWith(25);
      expect(mockOffset).toHaveBeenCalledWith(50);
    });

    it('uses defaults: limit 50, offset 0', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({});

      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockOffset).toHaveBeenCalledWith(0);
    });

    it('returns empty array for no matches', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      const result = await getAllAnalyticsEvents({ eventName: 'nonexistent.event' });

      expect(result).toEqual([]);
    });

    it('applies all filters simultaneously', async () => {
      mockOffset.mockResolvedValueOnce([]);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      await getAllAnalyticsEvents({
        eventName: 'dataset.uploaded',
        orgId: 3,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-03-31'),
        limit: 10,
        offset: 20,
      });

      expect(mockWhere).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(mockOffset).toHaveBeenCalledWith(20);
    });
  });

  describe('getAnalyticsEventsTotal', () => {
    it('returns count with no filters', async () => {
      mockWhere.mockResolvedValueOnce([{ value: 42 }]);

      const { getAnalyticsEventsTotal } = await import('./analyticsEvents.js');
      const result = await getAnalyticsEventsTotal({});

      expect(result).toBe(42);
    });

    it('returns 0 when no rows match', async () => {
      mockWhere.mockResolvedValueOnce([{ value: 0 }]);

      const { getAnalyticsEventsTotal } = await import('./analyticsEvents.js');
      const result = await getAnalyticsEventsTotal({ eventName: 'nothing' });

      expect(result).toBe(0);
    });

    it('applies same filters as getAllAnalyticsEvents', async () => {
      mockWhere.mockResolvedValueOnce([{ value: 7 }]);

      const { getAnalyticsEventsTotal } = await import('./analyticsEvents.js');
      const result = await getAnalyticsEventsTotal({
        eventName: 'user.signed_in',
        orgId: 2,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
      });

      expect(result).toBe(7);
      expect(mockSelect).toHaveBeenCalled();
    });
  });
});
