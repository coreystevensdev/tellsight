import { describe, it, expect } from 'vitest';

import { isBelowFloor, minimumSampleSize, sampleFloorBreach } from './sampleSizeFloors.js';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

describe('minimumSampleSize', () => {
  it('returns the configured floor for every gated stat type', () => {
    expect(minimumSampleSize(StatType.Average)).toBe(3);
    expect(minimumSampleSize(StatType.Trend)).toBe(6);
    expect(minimumSampleSize(StatType.Anomaly)).toBe(8);
    expect(minimumSampleSize(StatType.MarginTrend)).toBe(6);
    expect(minimumSampleSize(StatType.SeasonalProjection)).toBe(2);
    expect(minimumSampleSize(StatType.CashFlow)).toBe(3);
    expect(minimumSampleSize(StatType.Runway)).toBe(3);
    expect(minimumSampleSize(StatType.BreakEven)).toBe(6);
    expect(minimumSampleSize(StatType.CashForecast)).toBe(6);
  });

  it('leaves a stat type with no floor ungated', () => {
    expect(minimumSampleSize('total')).toBeNull();
  });

  it('leaves total, category_breakdown, category_variance and year_over_year ungated', () => {
    expect(minimumSampleSize(StatType.Total)).toBeNull();
    expect(minimumSampleSize(StatType.CategoryBreakdown)).toBeNull();
    expect(minimumSampleSize(StatType.CategoryVariance)).toBeNull();
    expect(minimumSampleSize(StatType.YearOverYear)).toBeNull();
  });

  it('gives break_even the same floor as the margin_trend window it inherits', () => {
    expect(minimumSampleSize(StatType.BreakEven)).toBe(minimumSampleSize(StatType.MarginTrend));
  });

  it('gives runway the same floor as the cash_flow window it inherits', () => {
    expect(minimumSampleSize(StatType.Runway)).toBe(minimumSampleSize(StatType.CashFlow));
  });
});

describe('isBelowFloor', () => {
  it('gates a regression-backed stat below its floor', () => {
    expect(isBelowFloor({ statType: 'trend', sampleSize: 3 } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: 'trend', sampleSize: 12 } as ComputedStat)).toBe(false);
  });

  it('never gates a stat whose sample size is null', () => {
    expect(isBelowFloor({ statType: 'cash_flow', sampleSize: null } as ComputedStat)).toBe(false);
  });

  it('gates a sample size of zero, which is not the same as null', () => {
    expect(isBelowFloor({ statType: 'trend', sampleSize: 0 } as ComputedStat)).toBe(true);
  });

  // null is a deliberate "no single n" (year_over_year); anything non-finite
  // compares false either direction against a floor in JS, so this used to
  // read as ungated no matter the stat type. null, a number, and zero all
  // keep their prior answers; only the non-finite cases flip. typeof alone
  // missed NaN and Infinity, both typeof 'number', both still comparing
  // false, so the predicate is Number.isFinite, not typeof.
  it('gates a missing sample size differently from null, even with no floor', () => {
    expect(isBelowFloor({ statType: 'trend', sampleSize: null } as ComputedStat)).toBe(false);
    expect(isBelowFloor({ statType: 'trend', sampleSize: 12 } as ComputedStat)).toBe(false);
    expect(isBelowFloor({ statType: 'trend', sampleSize: 0 } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: 'trend' } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: 'total' } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: 'trend', sampleSize: NaN } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: 'trend', sampleSize: Infinity } as ComputedStat)).toBe(true);
  });

  it('leaves a stat type with no floor ungated', () => {
    expect(minimumSampleSize('total')).toBeNull();
    expect(isBelowFloor({ statType: 'total', sampleSize: 1 } as ComputedStat)).toBe(false);
  });

  it('passes a stat exactly at its floor, below is strict', () => {
    expect(isBelowFloor({ statType: StatType.Anomaly, sampleSize: 8 } as ComputedStat)).toBe(false);
    expect(isBelowFloor({ statType: StatType.Anomaly, sampleSize: 7 } as ComputedStat)).toBe(true);
  });

  it('never gates year_over_year even though its sampleSize is always null in practice', () => {
    expect(
      isBelowFloor({ statType: StatType.YearOverYear, sampleSize: null } as ComputedStat),
    ).toBe(false);
  });

  it('gates a thin seasonal_projection basis but not a two-year one', () => {
    expect(
      isBelowFloor({ statType: StatType.SeasonalProjection, sampleSize: 1 } as ComputedStat),
    ).toBe(true);
    expect(
      isBelowFloor({ statType: StatType.SeasonalProjection, sampleSize: 2 } as ComputedStat),
    ).toBe(false);
  });

  it('gates a trend below six months but not at six, its own floor', () => {
    expect(isBelowFloor({ statType: StatType.Trend, sampleSize: 5 } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: StatType.Trend, sampleSize: 6 } as ComputedStat)).toBe(false);
  });

  it('gates a margin_trend window below six months on its thinner side', () => {
    expect(isBelowFloor({ statType: StatType.MarginTrend, sampleSize: 5 } as ComputedStat)).toBe(
      true,
    );
    expect(isBelowFloor({ statType: StatType.MarginTrend, sampleSize: 6 } as ComputedStat)).toBe(
      false,
    );
  });

  it('gates break_even and cash_forecast the same way margin_trend and trend do', () => {
    expect(isBelowFloor({ statType: StatType.BreakEven, sampleSize: 5 } as ComputedStat)).toBe(
      true,
    );
    expect(isBelowFloor({ statType: StatType.BreakEven, sampleSize: 6 } as ComputedStat)).toBe(
      false,
    );
    expect(isBelowFloor({ statType: StatType.CashForecast, sampleSize: 5 } as ComputedStat)).toBe(
      true,
    );
    expect(isBelowFloor({ statType: StatType.CashForecast, sampleSize: 6 } as ComputedStat)).toBe(
      false,
    );
  });

  it('gates the default 3-month cash_flow/runway window only if it ever gets shorter', () => {
    expect(isBelowFloor({ statType: StatType.CashFlow, sampleSize: 3 } as ComputedStat)).toBe(
      false,
    );
    expect(isBelowFloor({ statType: StatType.CashFlow, sampleSize: 2 } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: StatType.Runway, sampleSize: 2 } as ComputedStat)).toBe(true);
  });

  it('gates an average below three transactions', () => {
    expect(isBelowFloor({ statType: StatType.Average, sampleSize: 2 } as ComputedStat)).toBe(true);
    expect(isBelowFloor({ statType: StatType.Average, sampleSize: 3 } as ComputedStat)).toBe(false);
  });
});

describe('sampleFloorBreach', () => {
  it('reports the sampleSize and minimum for a stat below its floor', () => {
    expect(sampleFloorBreach({ statType: 'trend', sampleSize: 3 } as ComputedStat)).toEqual({
      sampleSize: 3,
      minimum: 6,
    });
  });

  it('reports null for a stat at or above its floor', () => {
    expect(sampleFloorBreach({ statType: 'trend', sampleSize: 6 } as ComputedStat)).toBeNull();
    expect(sampleFloorBreach({ statType: 'trend', sampleSize: 12 } as ComputedStat)).toBeNull();
  });

  it('reports null for year_over_year, whose sampleSize is deliberately null', () => {
    expect(
      sampleFloorBreach({ statType: StatType.YearOverYear, sampleSize: null } as ComputedStat),
    ).toBeNull();
  });

  // isBelowFloor fails closed here (true) even though minimumSampleSize('total')
  // is null, so "below floor" and "has a minimum worth citing" disagree. There's
  // no real minimum to report, and inventing one would tell the owner "fewer
  // than N months" for what is actually "this count isn't usable."
  it('reports null for an unusable sampleSize on a stat type with no floor', () => {
    expect(isBelowFloor({ statType: 'total', sampleSize: NaN } as ComputedStat)).toBe(true);
    expect(minimumSampleSize('total')).toBeNull();
    expect(sampleFloorBreach({ statType: 'total', sampleSize: NaN } as ComputedStat)).toBeNull();
  });

  it('reports null for an unusable sampleSize even on a stat type that does have a floor', () => {
    expect(sampleFloorBreach({ statType: 'trend', sampleSize: NaN } as ComputedStat)).toBeNull();
    expect(sampleFloorBreach({ statType: 'trend', sampleSize: Infinity } as ComputedStat)).toBeNull();
    expect(sampleFloorBreach({ statType: 'trend' } as ComputedStat)).toBeNull();
  });
});
