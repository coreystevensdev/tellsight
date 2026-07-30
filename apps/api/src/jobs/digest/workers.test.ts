import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockHandleOrchestratorJob = vi.fn().mockResolvedValue(undefined);
const mockHandlePerOrgJob = vi.fn().mockResolvedValue(undefined);
const mockHandlePerSendJob = vi.fn().mockResolvedValue(undefined);
const mockTrackEvent = vi.fn();

interface WorkerCall {
  name: string;
  processor: (job: unknown) => Promise<unknown>;
  opts: { concurrency: number; limiter?: { max: number; duration: number } };
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
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
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

vi.mock('./handlers/orchestrator.js', () => ({ handleOrchestratorJob: mockHandleOrchestratorJob }));
vi.mock('./handlers/perOrg.js', () => ({ handlePerOrgJob: mockHandlePerOrgJob }));
vi.mock('./handlers/perSend.js', () => ({ handlePerSendJob: mockHandlePerSendJob }));
vi.mock('../../services/analytics/trackEvent.js', () => ({ trackEvent: mockTrackEvent }));

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

describe('initDigestOrchestratorWorker', () => {
  it('binds to the orchestrator queue with concurrency 1', async () => {
    const { initDigestOrchestratorWorker } = await import('./workers.js');
    initDigestOrchestratorWorker();

    const w = findWorker('digest-orchestrator');
    expect(w.opts.concurrency).toBe(1);
    expect(w.opts.limiter).toBeUndefined();
  });

  it('is idempotent on repeat init calls', async () => {
    const { initDigestOrchestratorWorker } = await import('./workers.js');
    const a = initDigestOrchestratorWorker();
    const b = initDigestOrchestratorWorker();
    expect(a).toBe(b);
  });

  it('delegates to handleOrchestratorJob', async () => {
    const { initDigestOrchestratorWorker } = await import('./workers.js');
    initDigestOrchestratorWorker();

    const w = findWorker('digest-orchestrator');
    const job = { id: 'orch-1' };
    await w.processor(job);
    expect(mockHandleOrchestratorJob).toHaveBeenCalledWith(job);
  });
});

describe('initDigestOrgWorker', () => {
  it('binds to the org queue with concurrency 3', async () => {
    const { initDigestOrgWorker } = await import('./workers.js');
    initDigestOrgWorker();

    const w = findWorker('digest-org');
    expect(w.opts.concurrency).toBe(3);
    expect(w.opts.limiter).toBeUndefined();
  });

  it('delegates to handlePerOrgJob', async () => {
    const { initDigestOrgWorker } = await import('./workers.js');
    initDigestOrgWorker();

    const w = findWorker('digest-org');
    const job = { id: 'org-1' };
    await w.processor(job);
    expect(mockHandlePerOrgJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls', async () => {
    const { initDigestOrgWorker } = await import('./workers.js');
    const a = initDigestOrgWorker();
    const b = initDigestOrgWorker();
    expect(a).toBe(b);
  });
});

describe('initDigestSendWorker', () => {
  it('binds to the send queue with concurrency 10 + rate limiter 10/sec', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    initDigestSendWorker();

    const w = findWorker('digest-send');
    expect(w.opts.concurrency).toBe(10);
    expect(w.opts.limiter).toEqual({ max: 10, duration: 1_000 });
  });

  it('delegates to handlePerSendJob', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    initDigestSendWorker();

    const w = findWorker('digest-send');
    const job = { id: 'send-1' };
    await w.processor(job);
    expect(mockHandlePerSendJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    const a = initDigestSendWorker();
    const b = initDigestSendWorker();
    expect(a).toBe(b);
  });
});

describe('send worker retries-exhausted analytics (AC #8)', () => {
  const sendJobData = {
    userId: 7,
    orgId: 42,
    summaryId: 999,
    weekStart: new Date('2026-05-03T00:00:00Z'),
    userEmail: 'a@x.com',
    orgName: 'Acme',
    correlationId: 'corr-1',
  };

  it('emits DIGEST_FAILED only once attempts are exhausted', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    initDigestSendWorker();
    const w = findWorker('digest-send');

    const job = {
      id: 'send-x',
      data: sendJobData,
      attemptsMade: 1,
      opts: { attempts: 3 },
    };

    (w as unknown as { listeners: Map<string, Array<(...args: unknown[]) => void>> })
      .listeners.get('failed')!
      .forEach((fn) => fn(job, new Error('rate limited')));

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it('emits DIGEST_FAILED with retries_exhausted reason when attemptsMade hits the budget', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    initDigestSendWorker();
    const w = findWorker('digest-send');

    const finalJob = {
      id: 'send-y',
      data: sendJobData,
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    (w as unknown as { listeners: Map<string, Array<(...args: unknown[]) => void>> })
      .listeners.get('failed')!
      .forEach((fn) => fn(finalJob, new Error('still rate limited')));

    expect(mockTrackEvent).toHaveBeenCalledWith(
      42,
      7,
      'digest.failed',
      expect.objectContaining({
        reason: 'retries_exhausted',
        attemptsMade: 3,
        totalAttempts: 3,
        message: 'still rate limited',
        correlationId: 'corr-1',
      }),
    );
  });

  it('does not emit DIGEST_FAILED when job.data fails schema validation', async () => {
    const { initDigestSendWorker } = await import('./workers.js');
    initDigestSendWorker();
    const w = findWorker('digest-send');
    const { logger } = await import('../../lib/logger.js');

    const malformedJob = {
      id: 'send-z',
      data: { ...sendJobData, orgId: undefined },
      attemptsMade: 3,
      opts: { attempts: 3 },
    };

    (w as unknown as { listeners: Map<string, Array<(...args: unknown[]) => void>> })
      .listeners.get('failed')!
      .forEach((fn) => fn(malformedJob, new Error('still rate limited')));

    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'send-z',
        correlationId: 'corr-1',
        issues: expect.any(Array),
      }),
      expect.any(String),
    );
  });

  it('does not emit DIGEST_FAILED for the org or orchestrator workers', async () => {
    const { initDigestOrgWorker, initDigestOrchestratorWorker } = await import('./workers.js');
    initDigestOrgWorker();
    initDigestOrchestratorWorker();

    const orgW = findWorker('digest-org');
    const orchW = findWorker('digest-orchestrator');

    const orgJob = { id: 'org-1', data: {}, attemptsMade: 3, opts: { attempts: 3 } };
    orgW.listeners.get('failed')?.forEach((fn) => fn(orgJob, new Error('boom')));
    orchW.listeners.get('failed')?.forEach((fn) => fn(orgJob, new Error('boom')));

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe('shutdownDigestWorkers', () => {
  it('closes every initialized worker', async () => {
    const {
      initDigestOrchestratorWorker,
      initDigestOrgWorker,
      initDigestSendWorker,
      shutdownDigestWorkers,
    } = await import('./workers.js');
    initDigestOrchestratorWorker();
    initDigestOrgWorker();
    initDigestSendWorker();

    await shutdownDigestWorkers();

    expect(mockWorkerClose).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when nothing is initialized', async () => {
    const { shutdownDigestWorkers } = await import('./workers.js');
    await shutdownDigestWorkers();
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });
});
