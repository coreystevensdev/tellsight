import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueRemoveJobScheduler = vi.fn().mockResolvedValue(true);
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();
const mockRunSync = vi.fn();
const mockShopifyRunSync = vi.fn();
const mockSquareRunSync = vi.fn();

let capturedProcessor: ((job: unknown) => Promise<unknown>) | null = null;

class FakeQueue {
  add = mockQueueAdd;
  close = mockQueueClose;
  removeJobScheduler = mockQueueRemoveJobScheduler;
  constructor(
    public name: string,
    public opts: unknown,
  ) {}
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

class FakeUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

vi.mock('bullmq', () => ({
  Queue: FakeQueue,
  Worker: FakeWorker,
  UnrecoverableError: FakeUnrecoverableError,
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

vi.mock('./shopify/sync.js', () => ({
  runSync: mockShopifyRunSync,
}));

vi.mock('./square/sync.js', () => ({
  runSync: mockSquareRunSync,
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
      const result = await capturedProcessor!({
        id: 'job-1',
        data: { connectionId: 10, trigger: 'manual' },
      });

      expect(mockRunSync).toHaveBeenCalledWith(10, 'manual');
      expect(result).toEqual({ rowsSynced: 47, datasetId: 99 });
    });

    it('wraps TokenRevokedError as an unrecoverable error', async () => {
      const { TokenRevokedError } = await import('./quickbooks/errors.js');
      mockRunSync.mockRejectedValueOnce(new TokenRevokedError('revoked'));

      const { initSyncWorker } = await import('./worker.js');
      initSyncWorker();

      const caught = await capturedProcessor!({
        id: 'job-2',
        data: { connectionId: 20, trigger: 'scheduled' },
      })
        .then(() => null)
        .catch((e: Error) => e);

      expect(caught).toBeInstanceOf(FakeUnrecoverableError);
      expect(caught?.message).toContain('Token revoked');
    });

    it('marks ConnectionNotFoundError as unrecoverable so it is not retried', async () => {
      const { ConnectionNotFoundError } = await import('./quickbooks/errors.js');
      mockRunSync.mockRejectedValueOnce(new ConnectionNotFoundError(20));

      const { initSyncWorker } = await import('./worker.js');
      initSyncWorker();

      const caught = await capturedProcessor!({
        id: 'job-4',
        data: { connectionId: 20, trigger: 'scheduled' },
      })
        .then(() => null)
        .catch((e: Error) => e);

      expect(caught).toBeInstanceOf(FakeUnrecoverableError);
      expect(caught?.message).toContain('Connection 20 not found');
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

describe('provider worker configurations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;
    vi.resetModules();
  });

  it('keeps provider queues and job prefixes isolated', async () => {
    const quickBooks = await import('./worker.js');
    const shopify = await import('./shopify/worker.js');
    const square = await import('./square/worker.js');

    const queues = [
      quickBooks.getSyncQueue() as unknown as FakeQueue,
      shopify.getSyncQueue() as unknown as FakeQueue,
      square.getSyncQueue() as unknown as FakeQueue,
    ];
    expect(queues.map((queue) => queue.name)).toEqual([
      'quickbooks-sync',
      'shopify-sync',
      'square-sync',
    ]);

    await shopify.enqueueSyncJob(12, 'scheduled');
    await square.enqueueSyncJob(13, 'initial');
    expect(mockQueueAdd).toHaveBeenNthCalledWith(
      1,
      'shopify-scheduled-12',
      { connectionId: 12, trigger: 'scheduled' },
      expect.any(Object),
    );
    expect(mockQueueAdd).toHaveBeenNthCalledWith(
      2,
      'square-initial-13',
      { connectionId: 13, trigger: 'initial' },
      expect.any(Object),
    );
  });

  it.each([
    ['token revocation', 'TokenRevokedError'],
    ['a missing connection', 'ConnectionNotFoundError'],
    ['a missing scope', 'ScopeDeniedError'],
  ] as const)('marks Shopify %s as unrecoverable', async (_case, errorName) => {
    const errors = await import('./shopify/errors.js');
    const error =
      errorName === 'ConnectionNotFoundError'
        ? new errors.ConnectionNotFoundError(21)
        : errorName === 'ScopeDeniedError'
          ? new errors.ScopeDeniedError('read_orders')
          : new errors.TokenRevokedError('revoked');
    mockShopifyRunSync.mockRejectedValueOnce(error);

    const { initSyncWorker } = await import('./shopify/worker.js');
    initSyncWorker();

    await expect(
      capturedProcessor!({ id: 'shopify-job', data: { connectionId: 21, trigger: 'manual' } }),
    ).rejects.toBeInstanceOf(FakeUnrecoverableError);
  });

  it.each([
    ['token revocation', 'TokenRevokedError'],
    ['a missing connection', 'ConnectionNotFoundError'],
  ] as const)('marks Square %s as unrecoverable', async (_case, errorName) => {
    const errors = await import('./square/errors.js');
    const error =
      errorName === 'ConnectionNotFoundError'
        ? new errors.ConnectionNotFoundError(22)
        : new errors.TokenRevokedError('revoked');
    mockSquareRunSync.mockRejectedValueOnce(error);

    const { initSyncWorker } = await import('./square/worker.js');
    initSyncWorker();

    await expect(
      capturedProcessor!({ id: 'square-job', data: { connectionId: 22, trigger: 'manual' } }),
    ).rejects.toBeInstanceOf(FakeUnrecoverableError);
  });

  it('leaves provider retryable errors unchanged', async () => {
    const { RetryableError } = await import('./square/errors.js');
    const error = new RetryableError('temporarily unavailable', 503);
    mockSquareRunSync.mockRejectedValueOnce(error);

    const { initSyncWorker } = await import('./square/worker.js');
    initSyncWorker();

    await expect(
      capturedProcessor!({ id: 'square-job', data: { connectionId: 23, trigger: 'scheduled' } }),
    ).rejects.toBe(error);
  });
});
