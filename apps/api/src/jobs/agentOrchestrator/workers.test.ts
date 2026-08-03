import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
const mockHandleOrchestratorJob = vi.fn().mockResolvedValue(undefined);
const mockHandleEvaluateOrgJob = vi.fn().mockResolvedValue(undefined);

interface WorkerCall {
  name: string;
  processor: (job: unknown) => Promise<unknown>;
  opts: { concurrency: number; lockDuration?: number; maxStalledCount?: number };
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

describe('initAgentOrchestratorWorker', () => {
  it('binds to the orchestrator queue with concurrency 1 and an explicit lock', async () => {
    const { initAgentOrchestratorWorker } = await import('./workers.js');
    initAgentOrchestratorWorker();

    const w = findWorker('agent-orchestrator');
    expect(w.opts.concurrency).toBe(1);
    expect(w.opts.lockDuration).toBe(60_000);
    expect(w.opts.maxStalledCount).toBe(1);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initAgentOrchestratorWorker } = await import('./workers.js');
    const a = initAgentOrchestratorWorker();
    const b = initAgentOrchestratorWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'agent-orchestrator')).toHaveLength(1);
  });

  it('delegates to handleOrchestratorJob', async () => {
    const { initAgentOrchestratorWorker } = await import('./workers.js');
    initAgentOrchestratorWorker();

    const w = findWorker('agent-orchestrator');
    const job = { id: 'orch-1' };
    await w.processor(job);
    expect(mockHandleOrchestratorJob).toHaveBeenCalledWith(job);
  });

  it('logs and does not throw when the job fails or the worker errors', async () => {
    const { logger } = await import('../../lib/logger.js');
    const { initAgentOrchestratorWorker } = await import('./workers.js');
    initAgentOrchestratorWorker();

    const w = findWorker('agent-orchestrator');
    const job = { id: 'orch-2', attemptsMade: 2 };
    const jobErr = new Error('boom');
    w.listeners.get('failed')!.forEach((fn) => fn(job, jobErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'orchestrator', jobId: 'orch-2', attemptsMade: 2, err: jobErr }),
      'Agent orchestrator worker job failed',
    );

    const connErr = new Error('connection reset');
    w.listeners.get('error')!.forEach((fn) => fn(connErr));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'orchestrator', err: connErr }),
      'Agent orchestrator worker error',
    );
  });
});

describe('initAgentEvaluateOrgWorker', () => {
  it('binds to the evaluate-org queue with concurrency 3 and a lock long enough for an LLM call', async () => {
    const { initAgentEvaluateOrgWorker } = await import('./workers.js');
    initAgentEvaluateOrgWorker();

    const w = findWorker('agent-evaluate-org');
    expect(w.opts.concurrency).toBe(3);
    expect(w.opts.lockDuration).toBe(180_000);
    expect(w.opts.maxStalledCount).toBe(1);
  });

  it('delegates to handleEvaluateOrgJob', async () => {
    const { initAgentEvaluateOrgWorker } = await import('./workers.js');
    initAgentEvaluateOrgWorker();

    const w = findWorker('agent-evaluate-org');
    const job = { id: 'evaluate-1' };
    await w.processor(job);
    expect(mockHandleEvaluateOrgJob).toHaveBeenCalledWith(job);
  });

  it('is idempotent on repeat init calls, no second Worker constructed', async () => {
    const { initAgentEvaluateOrgWorker } = await import('./workers.js');
    const a = initAgentEvaluateOrgWorker();
    const b = initAgentEvaluateOrgWorker();
    expect(a).toBe(b);
    expect(workerCalls.filter((c) => c.name === 'agent-evaluate-org')).toHaveLength(1);
  });
});

describe('shutdownAgentOrchestratorWorkers', () => {
  it('closes every initialized worker', async () => {
    const { initAgentOrchestratorWorker, initAgentEvaluateOrgWorker, shutdownAgentOrchestratorWorkers } =
      await import('./workers.js');
    initAgentOrchestratorWorker();
    initAgentEvaluateOrgWorker();

    await shutdownAgentOrchestratorWorkers();

    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when nothing is initialized', async () => {
    const { shutdownAgentOrchestratorWorkers } = await import('./workers.js');
    await shutdownAgentOrchestratorWorkers();
    expect(mockWorkerClose).not.toHaveBeenCalled();
  });

  it('only closes the workers that were actually initialized', async () => {
    const { initAgentEvaluateOrgWorker, shutdownAgentOrchestratorWorkers } = await import('./workers.js');
    initAgentEvaluateOrgWorker();

    await shutdownAgentOrchestratorWorkers();

    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
  });

  it('logs which worker failed to close and still settles when one close() rejects', async () => {
    const { logger } = await import('../../lib/logger.js');
    const { initAgentOrchestratorWorker, initAgentEvaluateOrgWorker, shutdownAgentOrchestratorWorkers } =
      await import('./workers.js');
    initAgentOrchestratorWorker();
    initAgentEvaluateOrgWorker();
    const closeErr = new Error('redis connection dropped');
    mockWorkerClose.mockResolvedValueOnce(undefined).mockRejectedValueOnce(closeErr);

    await expect(shutdownAgentOrchestratorWorkers()).resolves.toBeUndefined();

    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      { label: 'evaluate-org', err: closeErr },
      'Agent orchestrator worker failed to close',
    );
  });

  it('does not log an error when both workers close cleanly', async () => {
    const { logger } = await import('../../lib/logger.js');
    const { initAgentOrchestratorWorker, shutdownAgentOrchestratorWorkers } = await import('./workers.js');
    initAgentOrchestratorWorker();

    await shutdownAgentOrchestratorWorkers();

    expect(logger.error).not.toHaveBeenCalled();
  });
});
