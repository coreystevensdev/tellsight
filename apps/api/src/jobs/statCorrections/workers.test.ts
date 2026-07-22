import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockHandleExpireJob = vi.fn().mockResolvedValue(undefined);

interface WorkerCall {
  name: string;
  processor: (job: unknown) => Promise<unknown>;
  opts: { concurrency: number };
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
}
const workerCalls: WorkerCall[] = [];

class FakeWorker {
  close = mockWorkerClose;
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(
    public name: string,
    processor: (job: unknown) => Promise<unknown>,
    opts: WorkerCall['opts'],
  ) {
    workerCalls.push({ name, processor, opts, listeners: this.listeners });
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    const arr = this.listeners.get(event) ?? [];
    arr.push(fn);
    this.listeners.set(event, arr);
    return this;
  }
}

vi.mock('bullmq', () => ({
  Queue: class { constructor(public name: string, public opts: unknown) {} },
  Worker: FakeWorker,
}));

vi.mock('../../config.js', () => ({ env: { REDIS_URL: 'redis://localhost:6379' } }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./handlers/expire.js', () => ({ handleExpireJob: mockHandleExpireJob }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  workerCalls.length = 0;
});

function findWorker(name: string): WorkerCall {
  const w = workerCalls.find((c) => c.name === name);
  if (!w) throw new Error(`No worker registered for ${name}`);
  return w;
}

describe('initStatCorrectionsExpireWorker', () => {
  it('binds to the expire queue with concurrency 1', async () => {
    const { initStatCorrectionsExpireWorker } = await import('./workers.js');
    initStatCorrectionsExpireWorker();

    const w = findWorker('stat-corrections-expire');
    expect(w.opts.concurrency).toBe(1);
  });

  it('delegates to handleExpireJob', async () => {
    const { initStatCorrectionsExpireWorker } = await import('./workers.js');
    initStatCorrectionsExpireWorker();

    const w = findWorker('stat-corrections-expire');
    const job = { id: 'expire-1' };
    await w.processor(job);
    expect(mockHandleExpireJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initStatCorrectionsExpireWorker } = await import('./workers.js');
    const a = initStatCorrectionsExpireWorker();
    const b = initStatCorrectionsExpireWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'stat-corrections-expire')).toHaveLength(1);
  });

  it('logs and does not throw when the job fails or the worker errors', async () => {
    const { logger } = await import('../../lib/logger.js');
    const { initStatCorrectionsExpireWorker } = await import('./workers.js');
    initStatCorrectionsExpireWorker();

    const w = findWorker('stat-corrections-expire');
    const job = { id: 'expire-2', attemptsMade: 2 };
    const jobErr = new Error('boom');
    w.listeners.get('failed')!.forEach((fn) => fn(job, jobErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'expire-2', attemptsMade: 2, err: jobErr }),
      'Stat corrections worker job failed',
    );

    const connErr = new Error('connection reset');
    w.listeners.get('error')!.forEach((fn) => fn(connErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: connErr }),
      'Stat corrections worker error',
    );
  });
});

describe('shutdownStatCorrectionsWorker', () => {
  it('closes the worker when initialized', async () => {
    const { initStatCorrectionsExpireWorker, shutdownStatCorrectionsWorker } = await import('./workers.js');
    initStatCorrectionsExpireWorker();

    await shutdownStatCorrectionsWorker();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is initialized', async () => {
    const { shutdownStatCorrectionsWorker } = await import('./workers.js');
    await shutdownStatCorrectionsWorker();
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });
});
