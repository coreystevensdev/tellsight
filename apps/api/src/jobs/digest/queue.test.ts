import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueueClose = vi.fn().mockResolvedValue(undefined);

class FakeQueue {
  close = mockQueueClose;
  constructor(public name: string, public opts: unknown) {}
}

vi.mock('bullmq', () => ({ Queue: FakeQueue }));

vi.mock('../../config.js', () => ({
  env: { REDIS_URL: 'redis://:secret@localhost:6379' },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('connectionOptions', () => {
  it('parses REDIS_URL into host/port/password', async () => {
    const { connectionOptions } = await import('./queue.js');
    const opts = connectionOptions();

    expect(opts).toMatchObject({
      host: 'localhost',
      port: 6379,
      password: 'secret',
      maxRetriesPerRequest: null,
    });
  });

  it('omits password when REDIS_URL has none', async () => {
    vi.doMock('../../config.js', () => ({
      env: { REDIS_URL: 'redis://localhost:6379' },
    }));
    const { connectionOptions } = await import('./queue.js');
    const opts = connectionOptions() as { password?: string };

    expect(opts.password).toBeUndefined();
  });
});

describe('queue singletons', () => {
  it('orchestrator queue is a singleton', async () => {
    const { getOrchestratorQueue } = await import('./queue.js');
    const q1 = getOrchestratorQueue();
    const q2 = getOrchestratorQueue();
    expect(q1).toBe(q2);
    expect((q1 as unknown as FakeQueue).name).toBe('digest-orchestrator');
  });

  it('org queue is a singleton with the right name', async () => {
    const { getOrgQueue } = await import('./queue.js');
    const q = getOrgQueue();
    expect((q as unknown as FakeQueue).name).toBe('digest-org');
  });

  it('send queue is a singleton with the right name', async () => {
    const { getSendQueue } = await import('./queue.js');
    const q = getSendQueue();
    expect((q as unknown as FakeQueue).name).toBe('digest-send');
  });

  it('the three queues are distinct instances', async () => {
    const { getOrchestratorQueue, getOrgQueue, getSendQueue } = await import('./queue.js');
    const a = getOrchestratorQueue();
    const b = getOrgQueue();
    const c = getSendQueue();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe('orgJobDataSchema', () => {
  const base = { orgId: 1, correlationId: 'c1' };

  it('coerces ISO string weekStart/weekEnd into Date instances', async () => {
    const { orgJobDataSchema } = await import('./queue.js');
    const result = orgJobDataSchema.safeParse({
      ...base,
      weekStart: '2026-05-03T00:00:00.000Z',
      weekEnd: '2026-05-10T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weekStart).toBeInstanceOf(Date);
      expect(result.data.weekEnd).toBeInstanceOf(Date);
      expect(result.data.weekStart.toISOString()).toBe('2026-05-03T00:00:00.000Z');
      expect(result.data.weekEnd.toISOString()).toBe('2026-05-10T00:00:00.000Z');
    }
  });

  it('accepts real Date instances', async () => {
    const { orgJobDataSchema } = await import('./queue.js');
    const weekStart = new Date('2026-05-03T00:00:00.000Z');
    const weekEnd = new Date('2026-05-10T00:00:00.000Z');
    const result = orgJobDataSchema.safeParse({ ...base, weekStart, weekEnd });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weekStart).toBeInstanceOf(Date);
      expect(result.data.weekEnd).toBeInstanceOf(Date);
    }
  });

  it('fails on an unparseable weekStart', async () => {
    const { orgJobDataSchema } = await import('./queue.js');
    const result = orgJobDataSchema.safeParse({
      ...base,
      weekStart: 'not-a-date',
      weekEnd: '2026-05-10T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('fails on an unparseable weekEnd', async () => {
    const { orgJobDataSchema } = await import('./queue.js');
    const result = orgJobDataSchema.safeParse({
      ...base,
      weekStart: '2026-05-03T00:00:00.000Z',
      weekEnd: 'not-a-date',
    });

    expect(result.success).toBe(false);
  });
});

describe('sendJobDataSchema', () => {
  const base = {
    userId: 1,
    orgId: 1,
    summaryId: 1,
    userEmail: 'owner@example.com',
    orgName: 'Acme',
    subjectLine: 'Your weekly digest',
    correlationId: 'c1',
  };

  it('coerces ISO string weekStart into a Date instance', async () => {
    const { sendJobDataSchema } = await import('./queue.js');
    const result = sendJobDataSchema.safeParse({
      ...base,
      weekStart: '2026-05-03T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weekStart).toBeInstanceOf(Date);
      expect(result.data.weekStart.toISOString()).toBe('2026-05-03T00:00:00.000Z');
    }
  });

  it('accepts a real Date instance', async () => {
    const { sendJobDataSchema } = await import('./queue.js');
    const result = sendJobDataSchema.safeParse({
      ...base,
      weekStart: new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.weekStart).toBeInstanceOf(Date);
    }
  });

  it('fails on an unparseable weekStart', async () => {
    const { sendJobDataSchema } = await import('./queue.js');
    const result = sendJobDataSchema.safeParse({ ...base, weekStart: 'not-a-date' });

    expect(result.success).toBe(false);
  });
});

describe('closeQueues', () => {
  it('closes any initialized queues and resets singletons', async () => {
    const { getOrchestratorQueue, getOrgQueue, closeQueues, getSendQueue } =
      await import('./queue.js');
    getOrchestratorQueue();
    getOrgQueue();

    await closeQueues();

    expect(mockQueueClose).toHaveBeenCalledTimes(2);

    // After reset, getters return fresh instances.
    const fresh = getSendQueue();
    expect(fresh).toBeDefined();
  });

  it('is a no-op when no queues were initialized', async () => {
    const { closeQueues } = await import('./queue.js');
    await closeQueues();
    expect(mockQueueClose).not.toHaveBeenCalled();
  });
});
