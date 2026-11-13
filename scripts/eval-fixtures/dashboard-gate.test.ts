import { describe, it, expect } from 'vitest';

import { dashboardGate } from './dashboard-gate.js';

const FLOORS = { faithfulness: 0.85, completeness: 0.8 };

function score(over: Partial<Parameters<typeof dashboardGate>[0][number]> = {}) {
  return {
    id: 'cash-crunch',
    faithfulness: { mean: 0.91 },
    completeness: { mean: 0.9 },
    legalPosture: { pass: true, violations: [] },
    plainLanguage: { pass: true, violations: [] },
    unmeasured: 0,
    errored: 0,
    sampledCount: 36,
    ...over,
  };
}

describe('dashboardGate', () => {
  it('passes a clean arm', () => {
    expect(dashboardGate([score()], 36, FLOORS)).toEqual([]);
  });

  it('breaches on faithfulness below the floor', () => {
    expect(dashboardGate([score({ faithfulness: { mean: 0.8 } })], 36, FLOORS)).toEqual([
      'cash-crunch: faithfulness 0.80 < 0.85',
    ]);
  });

  it('breaches on completeness below the floor', () => {
    expect(dashboardGate([score({ completeness: { mean: 0.75 } })], 36, FLOORS)).toEqual([
      'cash-crunch: completeness 0.75 < 0.8',
    ]);
  });

  it('breaches on a legal-posture failure and quotes the violations', () => {
    const breaches = dashboardGate(
      [score({ legalPosture: { pass: false, violations: ['directive: you should'] } })],
      36,
      FLOORS,
    );
    expect(breaches).toEqual(['cash-crunch: legal posture failed (directive: you should)']);
  });

  it('breaches on a plain-language failure and quotes the violations', () => {
    const breaches = dashboardGate(
      [score({ plainLanguage: { pass: false, violations: ['off-vocabulary term: "EBITDA"'] } })],
      36,
      FLOORS,
    );
    expect(breaches).toEqual([
      'cash-crunch: plain language failed (off-vocabulary term: "EBITDA")',
    ]);
  });

  it('reports a shed arm as inconclusive and grades nothing else on it', () => {
    // DW-250. The three survivors of a breaker trip are not a sample of 36, so a
    // mean over them is a different measurement rather than a smaller one. The
    // scores here would each breach, and none of those breaches should appear.
    const breaches = dashboardGate(
      [
        score({
          unmeasured: 33,
          sampledCount: 3,
          faithfulness: { mean: 0.1 },
          completeness: { mean: 0.1 },
          legalPosture: { pass: false, violations: ['directive'] },
        }),
      ],
      36,
      FLOORS,
    );
    expect(breaches).toEqual([
      'cash-crunch: inconclusive, 33 of 36 samples shed before reaching the API (scored 3, errored 0)',
    ]);
  });

  it('collects breaches across fixtures', () => {
    const breaches = dashboardGate(
      [
        score({ id: 'healthy-growth' }),
        score({ id: 'cash-crunch', faithfulness: { mean: 0.5 } }),
        score({ id: 'seasonal-anomaly', completeness: { mean: 0.1 } }),
      ],
      36,
      FLOORS,
    );
    expect(breaches).toHaveLength(2);
    expect(breaches[0]).toContain('cash-crunch: faithfulness');
    expect(breaches[1]).toContain('seasonal-anomaly: completeness');
  });
});
