import { describe, it, expect } from 'vitest';

import { formatAbbreviated, formatPercent } from './chartValueFormatters.js';

describe('formatAbbreviated', () => {
  it('returns $0 for zero', () => {
    expect(formatAbbreviated(0)).toBe('$0');
  });

  it('abbreviates thousands', () => {
    expect(formatAbbreviated(1200)).toBe('$1.2K');
    expect(formatAbbreviated(42300)).toBe('$42.3K');
  });

  it('abbreviates millions', () => {
    expect(formatAbbreviated(1200000)).toBe('$1.2M');
  });

  it('formats values under 1000 as full currency', () => {
    expect(formatAbbreviated(750)).toBe('$750');
  });
});

describe('formatPercent', () => {
  it('prefixes positive values with +', () => {
    expect(formatPercent(23)).toBe('+23%');
  });

  it('shows negative values with -', () => {
    expect(formatPercent(-8)).toBe('-8%');
  });

  it('shows zero without sign', () => {
    expect(formatPercent(0)).toBe('0%');
  });
});
