import { describe, it, expect } from 'vitest';

import { freshShedState, onShed, SHED_RETRIES_PER_SAMPLE } from './shed-retry.js';

describe('onShed', () => {
  it('retries a sample up to the budget, then gives up', () => {
    const s = freshShedState();
    for (let n = 1; n <= SHED_RETRIES_PER_SAMPLE; n++) {
      expect(onShed(s, 0)).toEqual({ action: 'retry', attempt: n });
    }
    expect(onShed(s, 0).action).toBe('giveUp');
  });

  it('gives the next sample its own budget', () => {
    // An arm that sheds once on each of several samples is recovering, not
    // failing, and must not inherit an earlier sample's spent budget.
    const s = freshShedState();
    onShed(s, 0);
    onShed(s, 0);
    onShed(s, 0);
    expect(onShed(s, 0).action).toBe('giveUp');
    expect(onShed(s, 1)).toEqual({ action: 'retry', attempt: 1 });
  });

  it('keeps giving up once a sample is spent, however many times it is asked', () => {
    const s = freshShedState();
    for (let n = 0; n < SHED_RETRIES_PER_SAMPLE; n++) onShed(s, 4);
    expect(onShed(s, 4).action).toBe('giveUp');
    expect(onShed(s, 4).action).toBe('giveUp');
  });

  it('honours a caller-supplied budget', () => {
    const s = freshShedState();
    expect(onShed(s, 0, 1).action).toBe('retry');
    expect(onShed(s, 0, 1).action).toBe('giveUp');
  });

  it('waits longer than the breaker cooldown it exists to outlast', async () => {
    const { SHED_RETRY_WAIT_MS } = await import('./shed-retry.js');
    // anthropicBreakers.ts: BREAKER_COOLDOWN_MS = 30_000. Waiting less than that
    // would re-enter an open breaker and shed again, burning the budget for free.
    expect(SHED_RETRY_WAIT_MS).toBeGreaterThan(30_000);
  });
});
