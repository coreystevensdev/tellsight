import { describe, it, expect, vi, afterEach } from 'vitest';

import { cachedHealth } from './cachedHealth.js';

afterEach(() => vi.useRealTimers());

describe('cachedHealth', () => {
  it('calls the probe once inside the window', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 'ok' });
    const get = cachedHealth(60_000, probe);

    expect(await get()).toEqual({ status: 'ok' });
    expect(await get()).toEqual({ status: 'ok' });
    expect(await get()).toEqual({ status: 'ok' });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('calls it again once the window is past', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-18T00:00:00Z'));
    const probe = vi.fn().mockResolvedValue({ status: 'ok' });
    const get = cachedHealth(60_000, probe);

    await get();
    vi.setSystemTime(new Date('2026-09-18T00:00:59Z'));
    await get();
    expect(probe).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-09-18T00:01:01Z'));
    await get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  // /health and /health/ready can be in the air together, and two concurrent
  // misses should make one upstream call rather than two.
  it('collapses concurrent misses into one call', async () => {
    let release!: (v: unknown) => void;
    const probe = vi.fn(() => new Promise((r) => { release = r; }));
    const get = cachedHealth(60_000, probe);

    const both = Promise.all([get(), get()]);
    release({ status: 'ok' });

    expect(await both).toEqual([{ status: 'ok' }, { status: 'ok' }]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  // A failed probe must not be remembered as the answer for the next minute,
  // and must not wedge the single-flight slot shut.
  it('does not cache a rejection, and recovers on the next call', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('upstream down'))
      .mockResolvedValue({ status: 'ok' });
    const get = cachedHealth(60_000, probe);

    await expect(get()).rejects.toThrow('upstream down');
    expect(await get()).toEqual({ status: 'ok' });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
