import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockLeftJoin = vi.fn();
const mockInnerJoin = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockOffset = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();

const chainable = {
  select: mockSelect,
  from: mockFrom,
  leftJoin: mockLeftJoin,
  innerJoin: mockInnerJoin,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  offset: mockOffset,
  insert: mockInsert,
  values: mockValues,
  onConflictDoNothing: mockOnConflictDoNothing,
  returning: mockReturning,
};

for (const fn of Object.values(chainable)) {
  fn.mockReturnValue(chainable);
}

vi.mock('../../lib/db.js', () => ({
  db: { select: mockSelect, insert: mockInsert },
  dbAdmin: { select: mockSelect, insert: mockInsert },
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
    dedupeKey: 'ae.dedupeKey',
  },
  orgs: { id: 'orgs.id', name: 'orgs.name' },
  users: { id: 'users.id', email: 'users.email', name: 'users.name' },
}));

beforeEach(() => vi.clearAllMocks());

describe('analyticsEvents queries', () => {
  describe('recordEvent', () => {
    it('throws on an empty returning() when no dedupeKey is passed', async () => {
      mockReturning.mockResolvedValueOnce([]);

      const { recordEvent } = await import('./analyticsEvents.js');

      await expect(recordEvent(10, 5, 'user.signed_in')).rejects.toThrow(
        'Insert failed to return analytics event',
      );
      expect(mockOnConflictDoNothing).not.toHaveBeenCalled();
    });

    it('applies onConflictDoNothing on the dedupe target and returns the inserted row', async () => {
      const fakeEvent = { id: 1, eventName: 'alert.muted' };
      mockReturning.mockResolvedValueOnce([fakeEvent]);

      const { recordEvent } = await import('./analyticsEvents.js');
      const { analyticsEvents } = await import('../schema.js');
      const result = await recordEvent(
        10,
        5,
        'alert.muted',
        { muteUntil: null },
        undefined,
        'alert.muted:1:58765',
      );

      expect(mockOnConflictDoNothing).toHaveBeenCalledWith({
        target: analyticsEvents.dedupeKey,
        where: ' IS NOT NULL',
      });
      expect(result).toEqual(fakeEvent);
    });

    it('returns null instead of throwing on a dedupeKey collision', async () => {
      mockReturning.mockResolvedValueOnce([]);

      const { recordEvent } = await import('./analyticsEvents.js');
      const result = await recordEvent(
        10,
        5,
        'alert.muted',
        { muteUntil: null },
        undefined,
        'alert.muted:1:58765',
      );

      expect(result).toBeNull();
    });
  });

  describe('getAllAnalyticsEvents', () => {
    it('returns events with org name and user email', async () => {
      const fakeEvents = [
        {
          id: 1, eventName: 'user.signed_in', orgName: 'Acme', userEmail: 'a@b.com',
          metadata: null, createdAt: new Date('2026-03-01'),
        },
      ];
      mockOffset.mockResolvedValueOnce(fakeEvents);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      const result = await getAllAnalyticsEvents({});

      expect(result).toEqual(fakeEvents);
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockLeftJoin).toHaveBeenCalledTimes(2);
      expect(mockInnerJoin).not.toHaveBeenCalled();
    });

    it('surfaces system-emitted rows with NULL org/user context', async () => {
      const systemRows = [
        {
          id: 99,
          eventName: 'email.bounced',
          orgName: null,
          userEmail: null,
          metadata: { messageId: 'msg-x', recipientEmail: 'co***@example.com' },
          createdAt: new Date('2026-05-07'),
        },
      ];
      mockOffset.mockResolvedValueOnce(systemRows);

      const { getAllAnalyticsEvents } = await import('./analyticsEvents.js');
      const result = await getAllAnalyticsEvents({});

      expect(result).toEqual(systemRows);
      expect(mockLeftJoin).toHaveBeenCalledTimes(2);
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
