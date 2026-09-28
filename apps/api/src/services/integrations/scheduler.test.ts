import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpsertJobScheduler = vi.fn();
const mockRemoveJobScheduler = vi.fn().mockResolvedValue(true);
const mockGetAllByProvider = vi.fn();

vi.mock('./worker.js', () => ({
  getSyncQueue: () => ({
    upsertJobScheduler: mockUpsertJobScheduler,
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
    it('registers a scheduler with 3am UTC cron', async () => {
      const { registerDailySync } = await import('./scheduler.js');
      await registerDailySync(10, 42);

      expect(mockUpsertJobScheduler).toHaveBeenCalledWith(
        'qb-daily-10',
        { pattern: '0 3 * * *' },
        expect.objectContaining({
          name: 'qb-daily-10',
          data: { connectionId: 42, trigger: 'scheduled' },
          opts: expect.objectContaining({ attempts: 3 }),
        }),
      );
    });

    it('uses an org-scoped scheduler id for uniqueness', async () => {
      const { registerDailySync } = await import('./scheduler.js');
      await registerDailySync(999, 1);

      const [schedulerId] = mockUpsertJobScheduler.mock.calls[0]!;
      expect(schedulerId).toBe('qb-daily-999');
    });
  });

  describe('removeDailySync', () => {
    it('removes by scheduler id', async () => {
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

      expect(mockUpsertJobScheduler).toHaveBeenCalledTimes(3);
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith('qb-daily-100', expect.any(Object), expect.any(Object));
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith('qb-daily-200', expect.any(Object), expect.any(Object));
      expect(mockUpsertJobScheduler).toHaveBeenCalledWith('qb-daily-300', expect.any(Object), expect.any(Object));
    });

    it('no-ops when no connections exist', async () => {
      mockGetAllByProvider.mockResolvedValueOnce([]);

      const { initScheduler } = await import('./scheduler.js');
      await initScheduler();

      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });

    it('logs and swallows errors during init', async () => {
      mockGetAllByProvider.mockRejectedValueOnce(new Error('DB down'));

      const { initScheduler } = await import('./scheduler.js');
      await expect(initScheduler()).resolves.toBeUndefined();

      expect(mockUpsertJobScheduler).not.toHaveBeenCalled();
    });
  });
});
