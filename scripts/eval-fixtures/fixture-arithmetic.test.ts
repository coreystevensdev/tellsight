import { describe, it, expect } from 'vitest';

import { FIXTURES } from './fixtures.js';
import type { ComputedStat } from '../../apps/api/src/services/curation/types.js';

// These fixtures are the eval's ground truth, and faithfulness grades the summary
// against them without ever grading them against the formulas that would produce
// them. So a fixture can hold numbers no input could generate and score 1.00
// forever. Four did.
//
// The break-even stat claimed a break-even revenue of 48000 from 16000 of fixed
// costs at a 20% margin, which is 80000; the model was told a shortfall a fifth
// of the real one. A Marketing trend claimed an 18% decline over endpoints of
// 1200 and 800, which is 33%, and both numbers render on the same prompt line, so
// the model received a sentence that contradicted itself. Three stats carried the
// wrong field in `value` entirely.
//
// These assert the relationships the compute functions guarantee. They are cheap
// and they run in CI, unlike the eval itself.

function statsOf(id: string): ComputedStat[] {
  const fixture = FIXTURES.find((f) => f.id === id);
  if (!fixture) throw new Error(`no fixture ${id}`);
  return fixture.build();
}

const ALL = FIXTURES.flatMap((f) => f.build());
const of = <T extends ComputedStat['statType']>(t: T) => ALL.filter((s) => s.statType === t);

describe('fixture stats are reachable by the production computations', () => {
  // computeTrends: value is the regression slope, and growthPercent is derived
  // from the endpoints it also reports.
  it.each(of('trend'))('trend/$category reports the decline its endpoints describe', (stat) => {
    const d = stat.details as { slope: number; growthPercent: number; firstValue: number; lastValue: number };

    expect(stat.value).toBe(d.slope);
    expect(d.growthPercent).toBeCloseTo(((d.lastValue - d.firstValue) / Math.abs(d.firstValue)) * 100, 1);
  });

  // computeBreakEven: breakEvenRevenue = fixedCosts / (margin/100), and value is
  // that revenue rather than the gap.
  it.each(of('break_even'))('break_even is the revenue its fixed costs and margin imply', (stat) => {
    const d = stat.details as {
      monthlyFixedCosts: number; marginPercent: number;
      breakEvenRevenue: number; currentMonthlyRevenue: number; gap: number;
    };

    expect(d.breakEvenRevenue).toBe(Math.round(d.monthlyFixedCosts / (d.marginPercent / 100)));
    expect(d.gap).toBe(d.breakEvenRevenue - d.currentMonthlyRevenue);
    expect(stat.value).toBe(d.breakEvenRevenue);
  });

  it.each(of('year_over_year'))('year_over_year change follows from its two years', (stat) => {
    const d = stat.details as { currentYear: number; priorYear: number; changePercent: number };

    expect(d.changePercent).toBeCloseTo(((d.currentYear - d.priorYear) / d.priorYear) * 100, 1);
    expect(stat.value).toBe(d.currentYear);
  });

  it.each(of('runway'))('runway months follow from cash and burn', (stat) => {
    const d = stat.details as { cashOnHand: number; monthlyNet: number; runwayMonths: number };

    expect(d.monthlyNet).toBeLessThan(0);
    expect(d.runwayMonths).toBeCloseTo(d.cashOnHand / Math.abs(d.monthlyNet), 1);
    expect(stat.value).toBe(d.runwayMonths);
  });

  it.each(of('cash_flow'))('cash_flow direction matches the sign of its net', (stat) => {
    const d = stat.details as { monthlyNet: number; direction: string; monthsBurning: number };

    expect(stat.value).toBe(d.monthlyNet);
    expect(d.direction).toBe(d.monthlyNet < 0 ? 'burning' : 'surplus');
    if (d.monthlyNet >= 0) expect(d.monthsBurning).toBe(0);
  });

  it.each(of('margin_trend'))('margin_trend direction matches its two margins', (stat) => {
    const d = stat.details as { recentMarginPercent: number; priorMarginPercent: number; direction: string };

    expect(stat.value).toBe(d.recentMarginPercent);
    if (d.direction === 'expanding') expect(d.recentMarginPercent).toBeGreaterThan(d.priorMarginPercent);
    if (d.direction === 'shrinking') expect(d.recentMarginPercent).toBeLessThan(d.priorMarginPercent);
  });

  // The projected balances have to be the running sum the slope produces, and the
  // crossing month has to be the first negative one.
  it.each(of('cash_forecast'))('cash_forecast balances follow its own slope', (stat) => {
    const d = stat.details as {
      startingBalance: number; slope: number; crossesZeroAtMonth: number | null;
      projectedMonths: { projectedNet: number; projectedBalance: number }[];
    };

    let running = d.startingBalance;
    d.projectedMonths.forEach((m, i) => {
      running += m.projectedNet;
      expect(m.projectedBalance, `month ${i + 1}`).toBe(running);
    });

    const firstNegative = d.projectedMonths.findIndex((m) => m.projectedBalance < 0);
    expect(d.crossesZeroAtMonth).toBe(firstNegative === -1 ? null : firstNegative + 1);
    expect(stat.value).toBe(d.projectedMonths.at(-1)!.projectedBalance);
  });

  it.each(of('seasonal_projection'))('seasonal_projection reports the amount it projected', (stat) => {
    const d = stat.details as { projectedAmount: number; basisValues: number[] };

    expect(stat.value).toBe(d.projectedAmount);
    expect(d.basisValues.length).toBeGreaterThan(0);
  });

  it.each(of('anomaly'))('anomaly deviates from a mean inside its own bounds', (stat) => {
    const d = stat.details as { direction: string; deviation: number; iqrBounds: { lower: number; upper: number } };
    const impliedMean = stat.value - d.deviation;

    expect(d.direction).toBe(stat.value > d.iqrBounds.upper ? 'above' : 'below');
    expect(impliedMean).toBeGreaterThanOrEqual(d.iqrBounds.lower);
    expect(impliedMean).toBeLessThanOrEqual(d.iqrBounds.upper);
  });

  // Guard against the whole file being renamed or emptied, which would make every
  // it.each above vacuous.
  it('is actually checking the fixtures', () => {
    expect(ALL.length).toBeGreaterThan(10);
    expect(statsOf('cash-crunch').length).toBeGreaterThan(0);
  });
});
