import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertJobScheduler = vi.fn();
const removeJobScheduler = vi.fn();
const getAllByProvider = vi.fn();

vi.mock('./worker.js', () => ({ getSyncQueue: () => ({ upsertJobScheduler, removeJobScheduler }) }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {} }));
vi.mock('../../../db/queries/index.js', () => ({
  integrationConnectionsQueries: { getAllByProvider: (...a: unknown[]) => getAllByProvider(...a) },
}));

const { registerDailySync, removeDailySync, initScheduler } = await import('./scheduler.js');

beforeEach(() => vi.clearAllMocks());

describe('square scheduler', () => {
  // All three providers share one org id space and BullMQ keys schedulers by
  // id, so an unprefixed id would have Square silently replace the QuickBooks
  // schedule for the same org.
  it('namespaces the scheduler away from the other providers', async () => {
    await registerDailySync(3, 7);
    const [schedulerId, , template] = upsertJobScheduler.mock.calls[0]!;
    expect(schedulerId).toBe('square-daily-3');
    expect(schedulerId).not.toBe('qb-daily-3');
    expect(schedulerId).not.toBe('shopify-daily-3');
    expect(template as { name: string; data: unknown }).toMatchObject({
      name: 'square-daily-3',
      data: { connectionId: 7, trigger: 'scheduled' },
    });
  });

  // 3am QuickBooks, 4am Shopify, 5am here: three providers waking every
  // connection in the same minute is a self-inflicted thundering herd.
  it('runs an hour after Shopify', async () => {
    await registerDailySync(3, 7);
    const repeatOpts = upsertJobScheduler.mock.calls[0]![1] as { pattern: string };
    expect(repeatOpts.pattern).toBe('0 5 * * *');
  });

  it('removes by the same id it registered', async () => {
    await removeDailySync(3);
    expect(removeJobScheduler).toHaveBeenCalledWith('square-daily-3');
  });

  it('registers every stored connection at boot', async () => {
    getAllByProvider.mockResolvedValue([
      { id: 7, orgId: 3 },
      { id: 8, orgId: 4 },
    ]);
    await initScheduler();
    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(upsertJobScheduler.mock.calls.map((c) => c[0])).toEqual([
      'square-daily-3',
      'square-daily-4',
    ]);
  });

  // Boot must not die because Redis is briefly unavailable; the API still
  // serves, and the next restart re-registers idempotently.
  it('survives a failure at boot instead of taking the API down', async () => {
    getAllByProvider.mockRejectedValue(new Error('redis down'));
    await expect(initScheduler()).resolves.toBeUndefined();
  });
});
