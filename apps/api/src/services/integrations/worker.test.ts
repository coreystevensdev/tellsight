import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueRemoveJobScheduler = vi.fn().mockResolvedValue(true);
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();
const mockRunSync = vi.fn();

let capturedProcessor: ((job: unknown) => Promise<unknown>) | null = null;

class FakeQueue {
  add = mockQueueAdd;
  close = mockQueueClose;
  removeJobScheduler = mockQueueRemoveJobScheduler;
  constructor(public name: string, public opts: unknown) {}
}

class FakeWorker {
  close = mockWorkerClose;
  on = mockWorkerOn;
  constructor(
    public name: string,
    processor: (job: unknown) => Promise<unknown>,
    public opts: unknown,
  ) {
    capturedProcessor = processor;
  }
}

vi.mock('bullmq', () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
}));

vi.mock('../../config.js', () => ({
  env: { REDIS_URL: 'redis://localhost:6379' },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./quickbooks/sync.js', () => ({
  runSync: mockRunSync,
}));

describe('worker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedProcessor = null;
    vi.resetModules();
  });

  describe('getSyncQueue', () => {
    it('creates a queue singleton', async () => {
      const { getSyncQueue } = await import('./worker.js');
      const q1 = getSyncQueue();
      const q2 = getSyncQueue();
      expect(q1).toBe(q2);
    });
  });

  describe('enqueueSyncJob', () => {
    it('adds a job with retry config', async () => {
      const { enqueueSyncJob } = await import('./worker.js');
      await enqueueSyncJob(42, 'manual');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'qb-manual-42',
        { connectionId: 42, trigger: 'manual' },
        expect.objectContaining({
          attempts: 3,
          backoff: expect.objectContaining({ type: 'exponential' }),
        }),
      );
    });

    it('uses initial trigger in job name', async () => {
      const { enqueueSyncJob } = await import('./worker.js');
      await enqueueSyncJob(5, 'initial');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'qb-initial-5',
        { connectionId: 5, trigger: 'initial' },
        expect.any(Object),
      );
    });
  });

  describe('initSyncWorker', () => {
    it('creates a worker with concurrency 2', async () => {
      const { initSyncWorker } = await import('./worker.js');
      const w = initSyncWorker();
      expect(w).toBeDefined();
      expect(mockWorkerOn).toHaveBeenCalledWith('failed', expect.any(Function));
      expect(mockWorkerOn).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('returns the same worker on repeat calls', async () => {
      const { initSyncWorker } = await import('./worker.js');
      const w1 = initSyncWorker();
      const w2 = initSyncWorker();
      expect(w1).toBe(w2);
    });

    it('processes jobs by calling runSync', async () => {
      mockRunSync.mockResolvedValueOnce({ rowsSynced: 47, datasetId: 99 });

      const { initSyncWorker } = await import('./worker.js');
      initSyncWorker();

      expect(capturedProcessor).toBeTruthy();
      const result = await capturedProcessor!({ id: 'job-1', data: { connectionId: 10, trigger: 'manual' } });

      expect(mockRunSync).toHaveBeenCalledWith(10, 'manual');
      expect(result).toEqual({ rowsSynced: 47, datasetId: 99 });
    });

    it('wraps TokenRevokedError as terminal error', async () => {
      const { TokenRevokedError } = await import('./quickbooks/errors.js');
      mockRunSync.mockRejectedValueOnce(new TokenRevokedError('revoked'));

      const { initSyncWorker } = await import('./worker.js');
      initSyncWorker();

      await expect(
        capturedProcessor!({ id: 'job-2', data: { connectionId: 20, trigger: 'scheduled' } }),
      ).rejects.toThrow('Token revoked');
    });

    it('re-throws retryable errors unchanged', async () => {
      const { RetryableError } = await import('./quickbooks/errors.js');
      const err = new RetryableError('rate limited', 429);
      mockRunSync.mockRejectedValueOnce(err);

      const { initSyncWorker } = await import('./worker.js');
      initSyncWorker();

      await expect(
        capturedProcessor!({ id: 'job-3', data: { connectionId: 30, trigger: 'manual' } }),
      ).rejects.toBe(err);
    });
  });

  describe('shutdownWorker', () => {
    it('closes both queue and worker', async () => {
      const { getSyncQueue, initSyncWorker, shutdownWorker } = await import('./worker.js');
      getSyncQueue();
      initSyncWorker();

      await shutdownWorker();

      expect(mockQueueClose).toHaveBeenCalled();
      expect(mockWorkerClose).toHaveBeenCalled();
    });

    it('is a no-op when nothing was initialized', async () => {
      const { shutdownWorker } = await import('./worker.js');
      await shutdownWorker();
      // should not throw, just verify it returns without error
      expect(mockQueueClose).not.toHaveBeenCalled();
      expect(mockWorkerClose).not.toHaveBeenCalled();
    });
  });
});
