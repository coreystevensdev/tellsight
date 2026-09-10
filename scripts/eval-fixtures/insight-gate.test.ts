import { describe, it, expect } from 'vitest';

import { insightGate, INSIGHT_MISS_CEILING } from './insight-gate.js';

// The numbers below are the real ones. v1.7 missed 5 of 18, a rule binding the
// observation to its next step took v1.8 to 1 in 36, and v1.9 measured 1 in 35.
// A gate that cannot separate the first from the other two is not worth running.

const run = (per: [misses: number, samples: number][]) =>
  per.map(([misses, sampledCount]) => ({ insight: { misses }, sampledCount }));

describe('insightGate', () => {
  it('pools across fixtures rather than judging each one', () => {
    const g = insightGate(run([
      [0, 12],
      [1, 12],
      [0, 11],
    ]));
    expect(g).toMatchObject({ misses: 1, samples: 35 });
    expect(g.over).toBe(false);
  });

  it('passes a clean run', () => {
    expect(insightGate(run([[0, 3], [0, 3], [0, 3]])).over).toBe(false);
  });

  // The whole point of the change. One miss at the default sample size is 11.1%,
  // which the old per-sample floor failed and a healthy prompt produces regularly.
  it('tolerates a single miss at the default sample size', () => {
    const g = insightGate(run([[1, 3], [0, 3], [0, 3]]));
    expect(g.rate).toBeCloseTo(0.111, 3);
    expect(g.over).toBe(false);
  });

  it('fails two misses at the default sample size', () => {
    expect(insightGate(run([[1, 3], [1, 3], [0, 3]])).over).toBe(true);
  });

  it("fails a regression the size of v1.7's", () => {
    const g = insightGate(run([[2, 6], [2, 6], [1, 6]]));
    expect(g).toMatchObject({ misses: 5, samples: 18 });
    expect(g.over).toBe(true);
  });

  // A run where every fixture died leaves no samples. Dividing by zero would make
  // the rate NaN, and NaN > ceiling is false, so it would pass silently. main()
  // treats zero results as its own failure, but this should not be the reason.
  it('reports a zero rate rather than NaN when nothing was scored', () => {
    expect(insightGate([])).toEqual({ misses: 0, samples: 0, rate: 0, over: false });
  });

  it('holds the ceiling above one-miss-in-nine', () => {
    expect(INSIGHT_MISS_CEILING).toBeGreaterThan(1 / 9);
  });
});
