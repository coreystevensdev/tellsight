import { describe, it, expect } from 'vitest';
import { BUSINESS_TYPES } from '../schemas/businessProfile.js';
import {
  SOI_BENCHMARKS,
  SOI_SOURCE,
  SOI_MARGIN_CAVEAT,
  netMarginPercent,
  payrollSharePercent,
  rentSharePercent,
  depreciationSharePercent,
  interestSharePercent,
} from './soi2023.js';

describe('SOI 2023 benchmarks', () => {
  it('cites a source precise enough to check a figure against', () => {
    expect(SOI_SOURCE.url).toMatch(/^https:\/\/www\.irs\.gov\//);
    expect(SOI_SOURCE.taxYear).toBe(2023);
    expect(SOI_SOURCE.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SOI_SOURCE.table).toBe('Table 1');
  });

  // Every row names the exact label it came from, so a figure can be traced back
  // to a line in the published file rather than to whoever typed it in.
  it('names the source row for every entry', () => {
    for (const [key, b] of Object.entries(SOI_BENCHMARKS)) {
      expect(b!.sector.length, key).toBeGreaterThan(3);
      expect(b!.businessReceipts, key).toBeGreaterThan(0);
      expect(b!.payroll, key).toBeGreaterThan(0);
    }
  });

  // technology is deliberately absent: SOI has no distinct technology sector, it
  // sits inside professional/scientific/technical services next to 'services'.
  // Showing it would be the other category's number under a different label.
  it('omits the one business type the source cannot distinguish', () => {
    expect(SOI_BENCHMARKS.technology).toBeUndefined();
    expect(SOI_BENCHMARKS.services?.sector).toContain('Professional');
  });

  it('covers every other business type onboarding can produce', () => {
    const missing = BUSINESS_TYPES.filter((t) => t !== 'technology' && !SOI_BENCHMARKS[t]);
    expect(missing).toEqual([]);
  });

  // A second, independent transcription of the figures. Deriving the percentage
  // is not enough on its own: transposing two digits in 77_216_690 still rounds
  // to 3.4%, so a mutation of exactly that shape passed every other test here.
  // Two copies that must agree is what actually catches a mistyped number.
  it.each([
    ['restaurant', 77_216_690, 2_610_484, 14_501_567],
    ['retail', 199_487_939, 8_219_358, 13_137_339],
    ['services', 250_227_539, 99_328_388, 19_929_703],
    ['construction', 382_517_598, 56_728_544, 42_198_457],
    ['healthcare', 147_497_660, 51_474_275, 20_652_555],
    ['manufacturing', 46_156_294, 3_259_834, 6_111_269],
    ['real_estate', 109_020_119, 26_440_210, 4_903_571],
    ['transportation', 200_084_105, 16_493_885, 8_396_222],
    ['other', 2_063_191_945, 377_210_993, 175_013_634],
  ] as const)('matches the published figures for %s', (key, receipts, netIncome, payroll) => {
    const b = SOI_BENCHMARKS[key as keyof typeof SOI_BENCHMARKS]!;
    expect(b.businessReceipts).toBe(receipts);
    expect(b.netIncomeLessDeficit).toBe(netIncome);
    expect(b.payroll).toBe(payroll);
  });

  it('derives the published margins from the raw figures', () => {
    expect(netMarginPercent(SOI_BENCHMARKS.restaurant!)).toBe(3.4);
    expect(netMarginPercent(SOI_BENCHMARKS.retail!)).toBe(4.1);
    expect(netMarginPercent(SOI_BENCHMARKS.construction!)).toBe(14.8);
    expect(netMarginPercent(SOI_BENCHMARKS.other!)).toBe(18.3);
  });

  it('derives payroll share the same way', () => {
    expect(payrollSharePercent(SOI_BENCHMARKS.restaurant!)).toBe(18.8);
    expect(payrollSharePercent(SOI_BENCHMARKS.real_estate!)).toBe(4.5);
  });

  it('returns null rather than Infinity when receipts are zero', () => {
    const broken = { sector: 'x', businessReceipts: 0, netIncomeLessDeficit: 5, payroll: 1 };
    expect(netMarginPercent(broken)).toBeNull();
    expect(payrollSharePercent(broken)).toBeNull();
  });

  // The caveat is the reason this data can ship at all, so it is asserted rather
  // than trusted to survive a refactor.
  it('carries the owner-compensation caveat with the data', () => {
    expect(SOI_MARGIN_CAVEAT).toMatch(/owner/i);
    expect(SOI_MARGIN_CAVEAT).toMatch(/salary|pay/i);
    // An LLC is a tax election, not a population of its own, so the caveat has
    // to name it. And it hedges rather than asserts: teamSize is a proxy, so a
    // reader can be routed to the wrong table without anything knowing.
    expect(SOI_MARGIN_CAVEAT).toMatch(/single-member LLC/i);
    expect(SOI_MARGIN_CAVEAT).toMatch(/if you/i);
  });

  // Second transcription for the expense columns, same reason as the margin
  // table above. Rent is summed from two source columns here and is a single
  // row in the employer table, so this is also what pins the two as the same
  // quantity rather than one of them quietly meaning something narrower.
  it.each([
    ['restaurant', 6.3, 3.0, 0.8],
    ['retail', 3.5, 1.9, 0.6],
    ['services', 2.6, 2.7, 0.5],
    ['construction', 1.5, 4.0, 0.5],
    ['healthcare', 4.7, 2.7, 0.6],
    ['manufacturing', 4.3, 4.1, 0.8],
    ['real_estate', 2.3, 6.4, 1.6],
    ['transportation', 3.7, 6.4, 0.7],
    ['other', 3.3, 3.9, 0.7],
  ] as const)('derives %s cost structure from the stored raw figures', (key, rent, deprec, interest) => {
    const b = SOI_BENCHMARKS[key];
    expect(b).toBeDefined();
    expect(rentSharePercent(b!)).toBe(rent);
    expect(depreciationSharePercent(b!)).toBe(deprec);
    expect(interestSharePercent(b!)).toBe(interest);
  });
});
