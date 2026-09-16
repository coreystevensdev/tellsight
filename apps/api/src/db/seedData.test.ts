import { describe, it, expect, afterEach, vi } from 'vitest';

import { buildSeedRows, SEED_DATASET_NAME } from './seedData.js';

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

describe('buildSeedRows', () => {
  afterEach(() => vi.useRealTimers());

  it('covers 12 months ending at the current one', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-16T00:00:00Z'));

    const months = [...new Set(buildSeedRows().map((r) => monthKey(r.date)))].sort();

    expect(months).toHaveLength(12);
    expect(months.at(0)).toBe('2025-10');
    expect(months.at(-1)).toBe('2026-09');
  });

  // The dashboard warns at 7 days and the digest stops at 30. Data that ended
  // when the seed script last ran would trip both on a brand-new account.
  it('reaches the current month across a year boundary', () => {
    vi.useFakeTimers().setSystemTime(new Date('2027-01-04T00:00:00Z'));

    const months = [...new Set(buildSeedRows().map((r) => monthKey(r.date)))].sort();

    expect(months.at(-1)).toBe('2027-01');
    expect(months.at(0)).toBe('2026-02');
  });

  it('bills rent once a month and everything else weekly', () => {
    const rows = buildSeedRows();
    const perMonth = (category: string) =>
      [...new Set(rows.filter((r) => r.category === category).map((r) => `${monthKey(r.date)}`))]
        .map((m) => rows.filter((r) => r.category === category && monthKey(r.date) === m).length);

    expect(new Set(perMonth('Rent'))).toEqual(new Set([1]));
    expect(new Set(perMonth('Revenue'))).toEqual(new Set([4]));
  });

  it('keeps the anomalies the curation pipeline is meant to find', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-16T00:00:00Z'));
    const rows = buildSeedRows();

    const monthly = (category: string, month: string) =>
      rows.filter((r) => r.category === category && monthKey(r.date) === month)
        .reduce((sum, r) => sum + parseFloat(r.amount), 0);

    // December revenue spike
    expect(monthly('Revenue', '2025-12')).toBeGreaterThan(monthly('Revenue', '2025-11') * 1.4);
    // October payroll jump
    expect(monthly('Payroll', '2025-10')).toBeGreaterThan(monthly('Payroll', '2025-09') * 1.3);
    // Q3 marketing cut
    expect(monthly('Marketing', '2026-08')).toBeLessThan(monthly('Marketing', '2026-05') / 2);
  });

  it('signs every amount as a positive decimal string', () => {
    const rows = buildSeedRows();

    expect(rows).not.toHaveLength(0);
    for (const r of rows) {
      expect(r.amount).toMatch(/^\d+\.\d{2}$/);
      expect(r.parentCategory === 'Income' || r.parentCategory === 'Expenses').toBe(true);
    }
  });

  it('names the dataset without a year range that goes stale', () => {
    expect(SEED_DATASET_NAME).not.toMatch(/\d{4}/);
  });
});
