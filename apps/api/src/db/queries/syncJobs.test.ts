import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsertValues = vi.fn();
const mockReturning = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<unknown[]> };
const mockUpdateSet = vi.fn();
const mockWhere = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<void> | undefined };
const mockSelectFrom = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn() as ReturnType<typeof vi.fn> & { _result: Promise<unknown[]> };

vi.mock('../../lib/db.js', () => ({
  db: {
    insert: () => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return { returning: () => { mockReturning(); return mockReturning._result; } };
      },
    }),
    update: () => ({
      set: (...args: unknown[]) => {
        mockUpdateSet(...args);
        return {
          where: (...w: unknown[]) => { mockWhere(...w); return mockWhere._result ?? Promise.resolve(); },
        };
      },
    }),
    select: () => ({
      from: (...args: unknown[]) => {
        mockSelectFrom(...args);
        return {
          where: (...w: unknown[]) => {
            mockWhere(...w);
            return {
              orderBy: (...o: unknown[]) => {
                mockOrderBy(...o);
                return { limit: (n: number) => { mockLimit(n); return mockLimit._result; } };
              },
            };
          },
        };
      },
    }),
  },
}));

vi.mock('../schema.js', () => ({
  syncJobs: {
    id: 'id',
    orgId: 'org_id',
    connectionId: 'connection_id',
    trigger: 'trigger',
    status: 'status',
    startedAt: 'started_at',
    completedAt: 'completed_at',
    rowsSynced: 'rows_synced',
    error: 'error',
    createdAt: 'created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
}));

const mockJob = {
  id: 1,
  orgId: 10,
  connectionId: 1,
  trigger: 'initial',
  status: 'queued',
  startedAt: null,
  completedAt: null,
  rowsSynced: 0,
  error: null,
  createdAt: new Date(),
};

describe('syncJobs queries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('inserts and returns job with default status', async () => {
      mockReturning._result =
        Promise.resolve([mockJob]);

      const { create } = await import('./syncJobs.js');
      const result = await create({
        orgId: 10,
        connectionId: 1,
        trigger: 'initial',
      });

      expect(result).toEqual(mockJob);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 10,
          connectionId: 1,
          trigger: 'initial',
        }),
      );
    });
  });

  describe('update', () => {
    it('sets completedAt and rowsSynced', async () => {
      mockWhere._result =
        Promise.resolve();

      const completedAt = new Date();
      const { update } = await import('./syncJobs.js');
      await update(1, { status: 'completed', completedAt, rowsSynced: 1247 });

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          completedAt,
          rowsSynced: 1247,
        }),
      );
    });

    it('sets error on failure', async () => {
      mockWhere._result =
        Promise.resolve();

      const { update } = await import('./syncJobs.js');
      await update(1, { status: 'failed', error: 'Rate limited' });

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          error: 'Rate limited',
        }),
      );
    });
  });

  describe('getRecent', () => {
    it('returns jobs ordered by createdAt desc', async () => {
      mockLimit._result =
        Promise.resolve([mockJob, { ...mockJob, id: 2 }]);

      const { getRecent } = await import('./syncJobs.js');
      const result = await getRecent(1, 5);

      expect(result).toHaveLength(2);
      expect(mockLimit).toHaveBeenCalledWith(5);
    });

    it('defaults to limit 10', async () => {
      mockLimit._result =
        Promise.resolve([]);

      const { getRecent } = await import('./syncJobs.js');
      await getRecent(1);

      expect(mockLimit).toHaveBeenCalledWith(10);
    });
  });
});
