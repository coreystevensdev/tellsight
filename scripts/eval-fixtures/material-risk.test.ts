import { describe, it, expect } from 'vitest';

import { cashCrunch, healthyGrowth, seasonalAnomaly } from './fixtures.js';
import { warrantedRisks, scoreRiskCoverage } from './material-risk.js';

describe('warrantedRisks', () => {
  it('fires on cash-crunch, whose runway is 2.4 months', () => {
    const risks = warrantedRisks(cashCrunch());
    expect(risks).toHaveLength(1);
    expect(risks[0]?.statType).toBe('runway');
    // The message carries the number, so a missed-risk breach is readable
    // without opening the fixture.
    expect(risks[0]?.because).toContain('2.4 months');
  });

  it('stays empty for the two fixtures with no runway stat', () => {
    // Neither emits a runway stat at all, so neither names a material risk the
    // prompt would have the agent flag. Silence on these is legitimate.
    expect(warrantedRisks(healthyGrowth())).toEqual([]);
    expect(warrantedRisks(seasonalAnomaly())).toEqual([]);
  });

  it('does not fire on a runway at or above the prompt floor', () => {
    const stats = cashCrunch().map((s) =>
      s.statType === 'runway' ? { ...s, details: { ...s.details, runwayMonths: 4 } } : s,
    );
    expect(warrantedRisks(stats)).toEqual([]);
  });
});

describe('scoreRiskCoverage', () => {
  const risks = warrantedRisks(cashCrunch());

  it('credits a proposal that cites the runway stat', () => {
    const r = scoreRiskCoverage(risks, [{ evidence: ['1:runway:_:0'] }]);
    expect(r.score).toBe(1);
    expect(r.missed).toEqual([]);
  });

  it('scores silence as a miss, not as unmeasured', () => {
    // The whole defect this replaces: 17 of 36 samples said nothing about a
    // 2.4-month runway and the old scoring filtered them out of the mean.
    const r = scoreRiskCoverage(risks, []);
    expect(r.score).toBe(0);
    expect(r.missed).toHaveLength(1);
  });

  it('does not credit a proposal that cites a different stat', () => {
    const r = scoreRiskCoverage(risks, [{ evidence: ['1:cash_flow:_:0'] }]);
    expect(r.score).toBe(0);
    expect(r.missed[0]?.statType).toBe('runway');
  });

  it('matches on the cited id, not on prose naming the stat', () => {
    // A title can say "runway" while the evidence points elsewhere. Evidence is
    // the field the prompt requires to be copied literally, so it is the tie.
    const r = scoreRiskCoverage(risks, [
      { evidence: ['1:break_even:_:0'] },
      { evidence: ['1:runway:_:0'] },
    ]);
    expect(r.score).toBe(1);
  });

  it('returns null, not 1, when no risk is warranted', () => {
    // A fixture with nothing to find must not average a perfect score in; that
    // would credit the arm for the fixture's calm instead of its own work.
    const r = scoreRiskCoverage([], [{ evidence: ['1:trend:Revenue:0'] }]);
    expect(r.score).toBeNull();
  });
});
