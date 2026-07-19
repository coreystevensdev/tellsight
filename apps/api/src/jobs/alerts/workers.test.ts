import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockHandleOrchestratorJob = vi.fn().mockResolvedValue(undefined);
const mockHandleEvaluateOrgJob = vi.fn().mockResolvedValue(undefined);
const mockHandleSendJob = vi.fn().mockResolvedValue(undefined);

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
vi.mock('./handlers/evaluateOrg.js', () => ({ handleEvaluateOrgJob: mockHandleEvaluateOrgJob }));
vi.mock('./handlers/send.js', () => ({ handleSendJob: mockHandleSendJob }));

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

describe('initAlertsOrchestratorWorker', () => {
  it('binds to the orchestrator queue with concurrency 1', async () => {
    const { initAlertsOrchestratorWorker } = await import('./workers.js');
    initAlertsOrchestratorWorker();

    const w = findWorker('alerts-orchestrator');
    expect(w.opts.concurrency).toBe(1);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initAlertsOrchestratorWorker } = await import('./workers.js');
    const a = initAlertsOrchestratorWorker();
    const b = initAlertsOrchestratorWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'alerts-orchestrator')).toHaveLength(1);
  });

  it('delegates to handleOrchestratorJob', async () => {
    const { initAlertsOrchestratorWorker } = await import('./workers.js');
    initAlertsOrchestratorWorker();

    const w = findWorker('alerts-orchestrator');
    const job = { id: 'orch-1' };
    await w.processor(job);
    expect(mockHandleOrchestratorJob).toHaveBeenCalledWith(job);
  });

  it('logs and does not throw when the job fails or the worker errors', async () => {
    const { logger } = await import('../../lib/logger.js');
    const { initAlertsOrchestratorWorker } = await import('./workers.js');
    initAlertsOrchestratorWorker();

    const w = findWorker('alerts-orchestrator');
    const job = { id: 'orch-2', attemptsMade: 2 };
    const jobErr = new Error('boom');
    w.listeners.get('failed')!.forEach((fn) => fn(job, jobErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'orchestrator', jobId: 'orch-2', attemptsMade: 2, err: jobErr }),
      'Alerts worker job failed',
    );

    const connErr = new Error('connection reset');
    w.listeners.get('error')!.forEach((fn) => fn(connErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'orchestrator', err: connErr }),
      'Alerts worker error',
    );
  });
});

describe('initAlertsEvaluateOrgWorker', () => {
  it('binds to the evaluate-org queue with concurrency 3', async () => {
    const { initAlertsEvaluateOrgWorker } = await import('./workers.js');
    initAlertsEvaluateOrgWorker();

    const w = findWorker('alerts-evaluate-org');
    expect(w.opts.concurrency).toBe(3);
  });

  it('delegates to handleEvaluateOrgJob', async () => {
    const { initAlertsEvaluateOrgWorker } = await import('./workers.js');
    initAlertsEvaluateOrgWorker();

    const w = findWorker('alerts-evaluate-org');
    const job = { id: 'evaluate-1' };
    await w.processor(job);
    expect(mockHandleEvaluateOrgJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initAlertsEvaluateOrgWorker } = await import('./workers.js');
    const a = initAlertsEvaluateOrgWorker();
    const b = initAlertsEvaluateOrgWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'alerts-evaluate-org')).toHaveLength(1);
  });
});

describe('initAlertsSendWorker', () => {
  it('binds to the send queue with concurrency 10', async () => {
    const { initAlertsSendWorker } = await import('./workers.js');
    initAlertsSendWorker();

    const w = findWorker('alerts-send');
    expect(w.opts.concurrency).toBe(10);
    // No rate limiter here, unlike digest's send worker: not a regression,
    // just unproven behavior we're not asserting either way.
    expect(w.opts.limiter).toBeUndefined();
  });

  it('delegates to handleSendJob', async () => {
    const { initAlertsSendWorker } = await import('./workers.js');
    initAlertsSendWorker();

    const w = findWorker('alerts-send');
    const job = { id: 'send-1' };
    await w.processor(job);
    expect(mockHandleSendJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initAlertsSendWorker } = await import('./workers.js');
    const a = initAlertsSendWorker();
    const b = initAlertsSendWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'alerts-send')).toHaveLength(1);
  });
});

describe('shutdownAlertsWorkers', () => {
  it('closes every initialized worker', async () => {
    const {
      initAlertsOrchestratorWorker,
      initAlertsEvaluateOrgWorker,
      initAlertsSendWorker,
      shutdownAlertsWorkers,
    } = await import('./workers.js');
    initAlertsOrchestratorWorker();
    initAlertsEvaluateOrgWorker();
    initAlertsSendWorker();

    await shutdownAlertsWorkers();

    expect(mockWorkerClose).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when nothing is initialized', async () => {
    const { shutdownAlertsWorkers } = await import('./workers.js');
    await shutdownAlertsWorkers();
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });

  it('only closes the workers that were actually initialized', async () => {
    const { initAlertsSendWorker, shutdownAlertsWorkers } = await import('./workers.js');
    initAlertsSendWorker();

    await shutdownAlertsWorkers();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
  });

  it('still closes the remaining workers when one close() rejects', async () => {
    const {
      initAlertsOrchestratorWorker,
      initAlertsEvaluateOrgWorker,
      initAlertsSendWorker,
      shutdownAlertsWorkers,
    } = await import('./workers.js');
    initAlertsOrchestratorWorker();
    initAlertsEvaluateOrgWorker();
    initAlertsSendWorker();
    mockWorkerClose.mockRejectedValueOnce(new Error('redis connection dropped'));

    await expect(shutdownAlertsWorkers()).resolves.toBeUndefined();

    expect(mockWorkerClose).toHaveBeenCalledTimes(3);
  });
});
