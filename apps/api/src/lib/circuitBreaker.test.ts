import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test' },
}));

vi.mock('./metrics.js', () => ({
  circuitBreakerState: { set: vi.fn() },
}));

import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';

class IgnoredError extends Error {}

const COOLDOWN_MS = 30_000;

function breaker(isIgnored?: (err: unknown) => boolean) {
  return new CircuitBreaker({ name: 'test-breaker', threshold: 3, cooldownMs: COOLDOWN_MS, isIgnored });
}

describe('CircuitBreaker', () => {
  it('stays closed and returns the result as long as calls succeed', async () => {
    const cb = breaker();

    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    expect(cb.isOpen()).toBe(false);
  });

  it('opens after threshold consecutive failures and fails fast on the next call', async () => {
    const cb = breaker();
    const fail = () => Promise.reject(new Error('boom'));

    await expect(cb.exec(fail)).rejects.toThrow('boom');
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    expect(cb.isOpen()).toBe(true);

    await expect(cb.exec(async () => 'should not run')).rejects.toThrow(CircuitOpenError);
  });

  it('does not count isIgnored errors toward the failure threshold', async () => {
    const cb = breaker((err) => err instanceof IgnoredError);
    const fail = () => Promise.reject(new Error('real failure'));
    const ignoredFail = () => Promise.reject(new IgnoredError('cost gate rejected'));

    await expect(cb.exec(ignoredFail)).rejects.toThrow(IgnoredError);
    await expect(cb.exec(ignoredFail)).rejects.toThrow(IgnoredError);
    expect(cb.isOpen()).toBe(false);

    await expect(cb.exec(fail)).rejects.toThrow('real failure');
    await expect(cb.exec(fail)).rejects.toThrow('real failure');
    expect(cb.isOpen()).toBe(false);
    await expect(cb.exec(fail)).rejects.toThrow('real failure');
    expect(cb.isOpen()).toBe(true);
  });

  it('resets the failure count on a success, so non-consecutive failures never trip it', async () => {
    const cb = breaker();
    const fail = () => Promise.reject(new Error('boom'));

    await expect(cb.exec(fail)).rejects.toThrow('boom');
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    await expect(cb.exec(async () => 'ok')).resolves.toBe('ok');
    expect(cb.isOpen()).toBe(false);

    await expect(cb.exec(fail)).rejects.toThrow('boom');
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    expect(cb.isOpen()).toBe(false);
  });

  describe('cooldown', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('allows a probe call once cooldownMs has elapsed after opening', async () => {
      const cb = breaker();
      const fail = () => Promise.reject(new Error('boom'));

      await expect(cb.exec(fail)).rejects.toThrow('boom');
      await expect(cb.exec(fail)).rejects.toThrow('boom');
      await expect(cb.exec(fail)).rejects.toThrow('boom');
      expect(cb.isOpen()).toBe(true);

      vi.advanceTimersByTime(COOLDOWN_MS - 1);
      await expect(cb.exec(async () => 'still open')).rejects.toThrow(CircuitOpenError);

      vi.advanceTimersByTime(1);
      await expect(cb.exec(async () => 'probe')).resolves.toBe('probe');
      expect(cb.isOpen()).toBe(false);
    });

    it('re-opens immediately if the half-open probe itself fails', async () => {
      const cb = breaker();
      const fail = () => Promise.reject(new Error('boom'));

      await expect(cb.exec(fail)).rejects.toThrow('boom');
      await expect(cb.exec(fail)).rejects.toThrow('boom');
      await expect(cb.exec(fail)).rejects.toThrow('boom');
      expect(cb.isOpen()).toBe(true);

      vi.advanceTimersByTime(COOLDOWN_MS);
      await expect(cb.exec(fail)).rejects.toThrow('boom');
      expect(cb.isOpen()).toBe(true);

      await expect(cb.exec(async () => 'still open')).rejects.toThrow(CircuitOpenError);
    });
  });
});
