import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueAdd = vi.fn();
const mockRemoveJobScheduler = vi.fn().mockResolvedValue(true);
const mockGetAllByProvider = vi.fn();

vi.mock('./worker.js', () => ({
  getSyncQueue: () => ({
    add: mockQueueAdd,
    removeJobScheduler: mockRemoveJobScheduler,
  }),
}));

vi.mock('../../db/queries/index.js', () => ({
  integrationConnectionsQueries: {
    getAllByProvider: mockGetAllByProvider,
  },
}));

vi.mock('../../lib/db.js', () => ({
  dbAdmin: {},
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerDailySync', () => {
    it('registers a repeatable job with 3am UTC cron', async () => {
      const { registerDailySync } = await import('./scheduler.js');
      await registerDailySync(10, 42);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'qb-daily-10',
        { connectionId: 42, trigger: 'scheduled' },
        expect.objectContaining({
          repeat: expect.objectContaining({ pattern: '0 3 * * *' }),
          jobId: 'qb-daily-10',
          attempts: 3,
        }),
      );
    });

    it('uses org-scoped jobId for uniqueness', async () => {
      const { registerDailySync } = await import('./scheduler.js');
      await registerDailySync(999, 1);

      const [name] = mockQueueAdd.mock.calls[0]!;
      expect(name).toBe('qb-daily-999');
    });
  });

  describe('removeDailySync', () => {
    it('removes by jobId', async () => {
      const { removeDailySync } = await import('./scheduler.js');
      await removeDailySync(10);

      expect(mockRemoveJobScheduler).toHaveBeenCalledWith('qb-daily-10');
    });
  });

  describe('initScheduler', () => {
    it('registers daily sync for each QB connection', async () => {
      mockGetAllByProvider.mockResolvedValueOnce([
        { id: 1, orgId: 100 },
        { id: 2, orgId: 200 },
        { id: 3, orgId: 300 },
      ]);

      const { initScheduler } = await import('./scheduler.js');
      await initScheduler();

      expect(mockQueueAdd).toHaveBeenCalledTimes(3);
      expect(mockQueueAdd).toHaveBeenCalledWith('qb-daily-100', expect.any(Object), expect.any(Object));
      expect(mockQueueAdd).toHaveBeenCalledWith('qb-daily-200', expect.any(Object), expect.any(Object));
      expect(mockQueueAdd).toHaveBeenCalledWith('qb-daily-300', expect.any(Object), expect.any(Object));
    });

    it('no-ops when no connections exist', async () => {
      mockGetAllByProvider.mockResolvedValueOnce([]);

      const { initScheduler } = await import('./scheduler.js');
      await initScheduler();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('logs and swallows errors during init', async () => {
      mockGetAllByProvider.mockRejectedValueOnce(new Error('DB down'));

      const { initScheduler } = await import('./scheduler.js');
      await expect(initScheduler()).resolves.toBeUndefined();

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });
});
