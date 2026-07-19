import { describe, it, expect } from 'vitest';

import { formatCurrency, computeTrend } from './formatters';

describe('formatCurrency', () => {
  it('formats whole numbers without decimals', () => {
    expect(formatCurrency(42300)).toBe('$42,300');
  });

  it('handles zero', () => {
    expect(formatCurrency(0)).toBe('$0');
  });

  it('handles negative values', () => {
    expect(formatCurrency(-1500)).toBe('-$1,500');
  });
});

describe('computeTrend', () => {
  it('returns null for fewer than 2 data points', () => {
    expect(computeTrend([])).toBeNull();
    expect(computeTrend([{ revenue: 100 }])).toBeNull();
  });

  it('calculates percentage change between last two entries', () => {
    const data = [{ revenue: 100 }, { revenue: 120 }];
    expect(computeTrend(data)).toBe(20);
  });

  it('handles zero previous value', () => {
    expect(computeTrend([{ revenue: 0 }, { revenue: 50 }])).toBe(100);
    expect(computeTrend([{ revenue: 0 }, { revenue: 0 }])).toBe(0);
  });

  it('returns -100 when previous is zero and current is negative', () => {
    expect(computeTrend([{ revenue: 0 }, { revenue: -200 }])).toBe(-100);
  });
});

