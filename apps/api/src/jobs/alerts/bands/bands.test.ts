import { describe, it, expect } from 'vitest';

import { getBand as runwayBand } from './runwayBands.js';
import { getBand as marginBand } from './marginBands.js';
import { getBand as cashBurnBand } from './cashBurnBands.js';
import { getBand as breakevenBand } from './breakevenBands.js';
import { getBand as anomalyBand, confidenceOrdinalFromZScore } from './anomalyBands.js';

describe('runwayBands (lower is worse)', () => {
  const threshold = 6; // months

  it('returns null above the threshold', () => {
    expect(runwayBand(7, threshold)).toBeNull();
  });

  it('returns band 1 at or below the threshold', () => {
    expect(runwayBand(6, threshold)).toBe(1);
    expect(runwayBand(3.5, threshold)).toBe(1);
  });

  it('returns band 2 at or below half the threshold', () => {
    expect(runwayBand(3, threshold)).toBe(2);
    expect(runwayBand(1.6, threshold)).toBe(2);
  });

  it('returns band 3 at or below a quarter of the threshold', () => {
    expect(runwayBand(1.5, threshold)).toBe(3);
    expect(runwayBand(0, threshold)).toBe(3);
  });
});

describe('marginBands (higher is worse)', () => {
  const threshold = 5; // percentage points dropped

  it('returns null below the threshold', () => {
    expect(marginBand(4, threshold)).toBeNull();
  });

  it('returns band 1 at or above the threshold', () => {
    expect(marginBand(5, threshold)).toBe(1);
    expect(marginBand(7, threshold)).toBe(1);
  });

  it('returns band 2 at or above 1.5x the threshold', () => {
    expect(marginBand(7.5, threshold)).toBe(2);
  });

  it('returns band 3 at or above 2x the threshold', () => {
    expect(marginBand(10, threshold)).toBe(3);
  });
});

describe('cashBurnBands (higher is worse)', () => {
  const threshold = 20; // percent spike

  it('returns null below the threshold', () => {
    expect(cashBurnBand(19, threshold)).toBeNull();
  });

  it('returns band 1/2/3 at the threshold multiples', () => {
    expect(cashBurnBand(20, threshold)).toBe(1);
    expect(cashBurnBand(30, threshold)).toBe(2);
    expect(cashBurnBand(40, threshold)).toBe(3);
  });
});

describe('breakevenBands (higher is worse)', () => {
  const threshold = 10; // percent gap

  it('returns null below the threshold', () => {
    expect(breakevenBand(9, threshold)).toBeNull();
  });

  it('returns band 1/2/3 at the threshold multiples', () => {
    expect(breakevenBand(10, threshold)).toBe(1);
    expect(breakevenBand(15, threshold)).toBe(2);
    expect(breakevenBand(20, threshold)).toBe(3);
  });
});

describe('anomalyBands (confidence ordinal)', () => {
  it('returns null when the current confidence is below the rule minimum', () => {
    expect(anomalyBand(1, 'moderate')).toBeNull();
  });

  it('returns the current ordinal when it meets the rule minimum', () => {
    expect(anomalyBand(2, 'moderate')).toBe(2);
    expect(anomalyBand(3, 'moderate')).toBe(3);
  });

  it('treats "low" as the loosest threshold, matching every confidence tier', () => {
    expect(anomalyBand(1, 'low')).toBe(1);
    expect(anomalyBand(2, 'low')).toBe(2);
    expect(anomalyBand(3, 'low')).toBe(3);
  });

  it('treats "high" as the strictest threshold, matching only the top tier', () => {
    expect(anomalyBand(1, 'high')).toBeNull();
    expect(anomalyBand(2, 'high')).toBeNull();
    expect(anomalyBand(3, 'high')).toBe(3);
  });
});

describe('confidenceOrdinalFromZScore', () => {
  it('returns 0 below the significance floor', () => {
    expect(confidenceOrdinalFromZScore(1.5)).toBe(0);
  });

  it('returns 1/2/3 at the low/moderate/high cutoffs', () => {
    expect(confidenceOrdinalFromZScore(2.0)).toBe(1);
    expect(confidenceOrdinalFromZScore(2.5)).toBe(2);
    expect(confidenceOrdinalFromZScore(3.0)).toBe(3);
  });

  it('takes the absolute value, direction does not matter', () => {
    expect(confidenceOrdinalFromZScore(-3.5)).toBe(3);
  });
});
