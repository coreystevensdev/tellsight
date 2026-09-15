import { describe, it, expect } from 'vitest';
import { BUSINESS_TYPES } from '../schemas/businessProfile.js';
import {
  SCORP_BENCHMARKS,
  SCORP_SOURCE,
  SCORP_ENTITY_CAVEAT,
  employerNetMarginPercent,
  employerPayrollSharePercent,
} from './scorp2022.js';
import { SOI_BENCHMARKS, netMarginPercent } from './soi2023.js';

describe('S-corp 2022 benchmarks', () => {
  it('cites a source precise enough to check a figure against', () => {
    expect(SCORP_SOURCE.url).toMatch(/^https:\/\/www\.irs\.gov\//);
    expect(SCORP_SOURCE.taxYear).toBe(2022);
    expect(SCORP_SOURCE.table).toBe('Table 6.1');
    expect(SCORP_SOURCE.retrievedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('covers every business type the sole-proprietor table covers', () => {
    const missing = BUSINESS_TYPES.filter((t) => t !== 'technology' && !SCORP_BENCHMARKS[t]);
    expect(missing).toEqual([]);
    expect(SCORP_BENCHMARKS.technology).toBeUndefined();
  });

  // A second, independent transcription. Deriving a percentage from stored raw
  // values is not enough on its own, because rounding absorbs the mistake a
  // human actually makes: transposing two digits in a nine-figure number still
  // lands on the same one-decimal percentage. Two copies that must agree is what
  // catches it, and it caught exactly that on the sole-proprietor table.
  it.each([
    ['restaurant', 4.3, 23.0],
    ['retail', 4.5, 8.3],
    ['services', 12.9, 27.5],
    ['construction', 5.3, 8.7],
    ['healthcare', 11.4, 38.7],
    ['manufacturing', 8.1, 9.5],
    ['real_estate', 15.1, 30.2],
    ['transportation', 6.1, 13.9],
    ['other', 7.3, 14.5],
  ])('%s derives to the figures read off the published table', (key, margin, payrollShare) => {
    const b = SCORP_BENCHMARKS[key as keyof typeof SCORP_BENCHMARKS]!;
    expect(employerNetMarginPercent(b)).toBe(margin);
    expect(employerPayrollSharePercent(b)).toBe(payrollShare);
  });

  // Officer compensation is the owner's own salary and is often the largest
  // payroll line in a small S-corp. Dropping it would understate payroll share
  // badly and, worse, would quietly make this table stop being the thing that
  // differs from the sole-proprietor one.
  it('counts officer compensation as payroll', () => {
    const services = SCORP_BENCHMARKS.services!;
    const withoutOfficers =
      Math.round((services.salariesAndWages / services.businessReceipts) * 1000) / 10;

    expect(employerPayrollSharePercent(services)).toBeGreaterThan(withoutOfficers);
  });
});

describe('why a second source exists', () => {
  // The whole reason for this file. A sole proprietor's net income still
  // contains their entire pay; an S-corp's does not, because it was deducted as
  // salary. The gap is large enough that showing the wrong one to a business
  // with employees tells them something untrue about themselves.
  it.each(['services', 'healthcare', 'construction'] as const)(
    '%s margin is materially lower once the owner is on payroll',
    (key) => {
      const soleProp = netMarginPercent(SOI_BENCHMARKS[key]!)!;
      const employer = employerNetMarginPercent(SCORP_BENCHMARKS[key]!)!;

      expect(employer).toBeLessThan(soleProp);
      expect(soleProp - employer).toBeGreaterThan(5);
    },
  );

  it('says so in the caveat rather than leaving it to be inferred', () => {
    expect(SCORP_ENTITY_CAVEAT).toMatch(/salary/i);
    expect(SCORP_ENTITY_CAVEAT).toMatch(/deducted/i);
  });
});
