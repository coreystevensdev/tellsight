import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  env: { NODE_ENV: 'test' },
}));

const mockGaugeSet = vi.fn();

vi.mock('./metrics.js', () => ({
  circuitBreakerState: { set: (...args: unknown[]) => mockGaugeSet(...args) },
}));

import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
import { AppError } from './appError.js';

class IgnoredError extends Error {}

const COOLDOWN_MS = 30_000;

function breaker(isIgnored?: (err: unknown) => boolean, name = 'test-breaker') {
  return new CircuitBreaker({ name, threshold: 3, cooldownMs: COOLDOWN_MS, isIgnored });
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

  // DW-208. Not being an AppError meant it missed every typed branch in the error
  // handler and landed in the unhandled arm: Sentry page plus a 500, for traffic
  // we shed on purpose.
  it('rejects with a 503 AppError that keeps the breaker name out of the client message', async () => {
    const cb = breaker(undefined, 'claude-api');
    const fail = () => Promise.reject(new Error('boom'));

    for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toThrow('boom');

    const shed = (await cb.exec(async () => 'x').catch((e: unknown) => e)) as CircuitOpenError;
    expect(shed).toBeInstanceOf(CircuitOpenError);
    expect(shed).toBeInstanceOf(AppError);
    expect(shed.statusCode).toBe(503);
    expect(shed.code).toBe('CIRCUIT_OPEN');
    expect(shed.breaker).toBe('claude-api');
    // errorHandler returns err.message to the caller verbatim.
    expect(shed.message).not.toContain('claude-api');
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

  // DW-207. The case above runs ignored errors and real ones in separate blocks,
  // which cannot tell "an ignored error is skipped" apart from "an ignored error
  // zeroes the count". Interleaving them can.
  it('skips an ignored error without clearing the failures already counted', async () => {
    const cb = breaker((err) => err instanceof IgnoredError);
    const fail = () => Promise.reject(new Error('real failure'));
    const ignoredFail = () => Promise.reject(new IgnoredError('cost gate rejected'));

    await expect(cb.exec(fail)).rejects.toThrow('real failure');
    await expect(cb.exec(ignoredFail)).rejects.toThrow(IgnoredError);
    await expect(cb.exec(fail)).rejects.toThrow('real failure');
    await expect(cb.exec(ignoredFail)).rejects.toThrow(IgnoredError);
    expect(cb.isOpen()).toBe(false);

    // Third real failure, so the two ignored ones in between must have left the
    // running count alone rather than restarting it.
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

  describe('instance isolation', () => {
    // Braced deliberately: mockClear() returns the mock, and a function returned
    // from beforeEach is treated as a teardown callback, so an expression body
    // gets the spy invoked once after every test in this block.
    beforeEach(() => {
      mockGaugeSet.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens only the instance that failed, leaving a sibling closed and callable', async () => {
      const a = breaker(undefined, 'breaker-a');
      const b = breaker(undefined, 'breaker-b');
      const fail = () => Promise.reject(new Error('boom'));

      await expect(a.exec(fail)).rejects.toThrow('boom');
      await expect(a.exec(fail)).rejects.toThrow('boom');
      await expect(a.exec(fail)).rejects.toThrow('boom');

      expect(a.isOpen()).toBe(true);
      expect(b.isOpen()).toBe(false);
      // Keep the type check and the name check separate. A regex on the message
      // alone would pass for any Error carrying that substring, and would break
      // on a reword that changes no behavior.
      const shed = (await a.exec(async () => 'should not run').catch((e: unknown) => e)) as CircuitOpenError;
      expect(shed).toBeInstanceOf(CircuitOpenError);
      expect(shed.breaker).toBe('breaker-a');
      expect(mockGaugeSet).toHaveBeenCalledWith({ name: 'breaker-a' }, 1);
      await expect(b.exec(async () => 'ok')).resolves.toBe('ok');
    });

    // Four failures across two breakers, two each. A pooled counter would hit the
    // threshold of 3 and trip; per-instance counters leave both closed.
    it('does not pool failure counts across instances', async () => {
      const a = breaker(undefined, 'breaker-a');
      const b = breaker(undefined, 'breaker-b');
      const fail = () => Promise.reject(new Error('boom'));

      await expect(a.exec(fail)).rejects.toThrow('boom');
      await expect(b.exec(fail)).rejects.toThrow('boom');
      await expect(a.exec(fail)).rejects.toThrow('boom');
      await expect(b.exec(fail)).rejects.toThrow('boom');

      expect(a.isOpen()).toBe(false);
      expect(b.isOpen()).toBe(false);
      await expect(a.exec(async () => 'ok')).resolves.toBe('ok');
      await expect(b.exec(async () => 'ok')).resolves.toBe('ok');
    });

    // failures and state being per-instance is not enough: lastFailure drives the
    // cooldown, so a shared clock would let a quiet breaker ride a busy one's probe.
    it('keeps the cooldown clock per instance', async () => {
      vi.useFakeTimers();
      const a = breaker(undefined, 'breaker-a');
      const b = breaker(undefined, 'breaker-b');
      const fail = () => Promise.reject(new Error('boom'));

      for (let i = 0; i < 3; i++) await expect(a.exec(fail)).rejects.toThrow('boom');
      vi.advanceTimersByTime(COOLDOWN_MS - 1);
      for (let i = 0; i < 3; i++) await expect(b.exec(fail)).rejects.toThrow('boom');

      // Without this, a resolving probe below is equally explained by "a never opened".
      expect(a.isOpen()).toBe(true);
      expect(b.isOpen()).toBe(true);

      vi.advanceTimersByTime(1);
      await expect(a.exec(async () => 'probe')).resolves.toBe('probe');
      expect(a.isOpen()).toBe(false);
      // The recovery write is the only thing that clears circuit_breaker_open.
      // Drop it and the gauge latches at 1 for the life of the process.
      expect(mockGaugeSet).toHaveBeenCalledWith({ name: 'breaker-a' }, 0);

      await expect(b.exec(async () => 'too soon')).rejects.toThrow(CircuitOpenError);
      expect(b.isOpen()).toBe(true);
    });
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

    // DW-209. The first caller past the cooldown flips to half-open and then
    // awaits. Every caller arriving during that await used to sail through the
    // gate and become a probe of its own.
    it('admits one probe at a time when the cooldown expires under load', async () => {
      const cb = breaker();
      const fail = () => Promise.reject(new Error('boom'));

      for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toThrow('boom');
      expect(cb.isOpen()).toBe(true);

      vi.advanceTimersByTime(COOLDOWN_MS);

      let release!: (value: string) => void;
      const inFlight = new Promise<string>((resolve) => {
        release = resolve;
      });
      const probe = cb.exec(() => inFlight);

      await expect(cb.exec(async () => 'me too')).rejects.toThrow(CircuitOpenError);
      await expect(cb.exec(async () => 'me three')).rejects.toThrow(CircuitOpenError);

      release('probe');
      await expect(probe).resolves.toBe('probe');
      expect(cb.isOpen()).toBe(false);
    });

    // DW-204. An ignored error is not evidence either way about the upstream, so
    // a probe that ends in one must not leave the breaker admitting traffic.
    it('goes back to open when the probe ends in an ignored error', async () => {
      const cb = breaker((err) => err instanceof IgnoredError);
      const fail = () => Promise.reject(new Error('boom'));

      for (let i = 0; i < 3; i++) await expect(cb.exec(fail)).rejects.toThrow('boom');
      expect(cb.isOpen()).toBe(true);

      vi.advanceTimersByTime(COOLDOWN_MS);
      const abort = () => Promise.reject(new IgnoredError('client went away'));
      await expect(cb.exec(abort)).rejects.toThrow(IgnoredError);

      expect(cb.isOpen()).toBe(true);
      await expect(cb.exec(async () => 'should not run')).rejects.toThrow(CircuitOpenError);

      // The probe slot was spent, so recovery waits out another full cooldown.
      vi.advanceTimersByTime(COOLDOWN_MS);
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
