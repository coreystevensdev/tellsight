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

// simple-statistics' median: mean of the two middle values at even length.
// Written out for the same reason leastSquares below is.
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Ordinary least squares, the same fit simple-statistics' linearRegression
// performs. Written out rather than imported: scripts/ has no package.json so
// that dependency does not resolve here, and a check is worth more when it does
// not share an implementation with the thing it checks.
function leastSquares(ys: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  const sumX = ys.reduce((total, _y, x) => total + x, 0);
  const sumY = ys.reduce((total, y) => total + y, 0);
  const sumXY = ys.reduce((total, y, x) => total + x * y, 0);
  const sumXX = ys.reduce((total, _y, x) => total + x * x, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return { slope, intercept: (sumY - slope * sumX) / n };
}

// Mirrors cashForecastMetrics.ts's own nextMonthKey. Duplicated rather than
// imported because that one is private, and a check that imported the thing it
// is checking would pass on a shared mistake.
function nextMonthKey(yyyymm: string, delta: number): string {
  const [year, month] = yyyymm.split('-').map(Number);
  const monthIdx = month! - 1 + delta;
  const yearAdd = Math.floor(monthIdx / 12);
  return `${year! + yearAdd}-${String((((monthIdx % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

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

  it.each(of('year_over_year'))('year_over_year change follows from its two revenue figures', (stat) => {
    const d = stat.details as { currentRevenue: number; priorRevenue: number; changePercent: number };

    expect(d.changePercent).toBeCloseTo(((d.currentRevenue - d.priorRevenue) / d.priorRevenue) * 100, 1);
    expect(stat.value).toBe(d.currentRevenue);
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

  // DW-234. computeCashForecast fits linearRegression over the basis, then
  // projects three months at t = n, n+1, n+2 and runs the balance forward. Every
  // number in details follows from basisValues and startingBalance, so all of it
  // is re-derived rather than spot-checked. The fixture claimed slope -9000 and
  // intercept 24000 where its own basis regressed to -1465 and 2474, held
  // projectedNet flat at -9000 while claiming a slope, and started its projected
  // months six months after the basis ended. None of it reaches the prompt or the
  // citable set, so the eval scored it 1.00 regardless, which is exactly why the
  // arithmetic needs asserting somewhere cheap.
  it.each(of('cash_forecast'))('cash_forecast re-derives from its own basis', (stat) => {
    const d = stat.details as {
      startingBalance: number; slope: number; intercept: number; method: string;
      basisMonths: string[]; basisValues: number[];
      projectedMonths: { month: string; projectedNet: number; projectedBalance: number }[];
      crossesZeroAtMonth: number | null;
    };

    expect(d.basisValues.length).toBe(d.basisMonths.length);
    expect(stat.sampleSize).toBe(d.basisMonths.length);

    const fit = leastSquares(d.basisValues);
    expect(d.slope).toBeCloseTo(fit.slope, 6);
    expect(d.intercept).toBeCloseTo(fit.intercept, 6);

    const n = d.basisMonths.length;
    let running = d.startingBalance;
    d.projectedMonths.forEach((pm, index) => {
      const t = n + index;
      expect(pm.projectedNet).toBe(Math.round(d.slope * t + d.intercept));
      running = Math.round(running + pm.projectedNet);
      expect(pm.projectedBalance).toBe(running);
      expect(pm.month).toBe(nextMonthKey(d.basisMonths[n - 1]!, index + 1));
    });

    const crossIdx = d.projectedMonths.findIndex((pm) => pm.projectedBalance < 0);
    expect(d.crossesZeroAtMonth).toBe(crossIdx === -1 ? null : crossIdx + 1);
    expect(stat.value).toBe(d.projectedMonths.at(-1)!.projectedBalance);
  });

  // buildCashFlowStat derives every one of these from recentMonths
  // (cashFlowMetrics.ts:52-69), so none of them is independently assertable: a
  // cash_flow stat whose series does not produce its own monthlyNet is a stat
  // the producer could not have emitted. This fixture carried `recentMonths: []`
  // with a monthlyNet of 9000 beside it, which is that exact shape.
  it.each(of('cash_flow'))('cash_flow derives its figures from its own months', (stat) => {
    const d = stat.details as {
      monthlyNet: number; trailingMonths: number; direction: string; monthsBurning: number;
      recentMonths: { month: string; revenue: number; expenses: number; net: number }[];
    };

    // An empty series is the specific defect this guards, and every assertion
    // below passes vacuously on one, so it is checked first.
    expect(d.recentMonths.length).toBe(d.trailingMonths);
    expect(stat.sampleSize).toBe(d.trailingMonths);

    for (const m of d.recentMonths) {
      expect(m.net).toBe(m.revenue - m.expenses);
      // A zero-revenue month makes buildCashFlowStat return no stat at all.
      expect(m.revenue).toBeGreaterThan(0);
    }

    const nets = d.recentMonths.map((m) => m.net);
    expect(d.monthlyNet).toBeCloseTo(median(nets), 6);
    expect(stat.value).toBeCloseTo(d.monthlyNet, 6);
    expect(d.monthsBurning).toBe(nets.filter((n) => n < 0).length);
    expect(d.direction).toBe(d.monthlyNet < 0 ? 'burning' : 'surplus');

    const months = d.recentMonths.map((m) => m.month);
    expect(months).toEqual([...months].sort());
    expect(new Set(months).size).toBe(months.length);
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
