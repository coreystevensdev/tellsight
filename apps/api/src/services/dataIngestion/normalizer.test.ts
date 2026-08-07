import { describe, it, expect } from 'vitest';
import { normalizeRows } from './normalizer.js';
import type { ParsedRow } from '../adapters/index.js';

describe('normalizeRows', () => {
  const headers = ['date', 'amount', 'category', 'label', 'parent_category'];

  it('transforms parsed rows to schema shape', () => {
    const rows: ParsedRow[] = [
      { date: '2025-01-15', amount: '1,200.00', category: 'Revenue', label: 'Monthly sales', parent_category: 'Income' },
    ];

    const result = normalizeRows(rows, headers);
    expect(result).toHaveLength(1);

    const row = result[0]!;
    expect(row.category).toBe('Revenue');
    expect(row.parentCategory).toBe('Income');
    expect(row.date).toBeInstanceOf(Date);
    expect(row.amount).toBe('1200.00'); // commas stripped
    expect(row.label).toBe('Monthly sales');
    expect(row.metadata).toBeNull();
  });

  it('sets optional fields to null when absent', () => {
    const rows: ParsedRow[] = [
      { date: '2025-01-15', amount: '500', category: 'Expenses' },
    ];
    const minHeaders = ['date', 'amount', 'category'];

    const result = normalizeRows(rows, minHeaders);
    expect(result[0]!.parentCategory).toBeNull();
    expect(result[0]!.label).toBeNull();
  });

  it('trims category whitespace', () => {
    const rows: ParsedRow[] = [
      { date: '2025-01-15', amount: '500', category: '  Revenue  ', label: '', parent_category: '' },
    ];

    const result = normalizeRows(rows, headers);
    expect(result[0]!.category).toBe('Revenue');
    expect(result[0]!.label).toBeNull(); // empty string → null
    expect(result[0]!.parentCategory).toBeNull(); // empty string → null
  });

  it('resolves aliased column names end-to-end (invoice_date, total, product)', () => {
    const aliasedHeaders = ['invoice_date', 'total', 'product'];
    const rows: ParsedRow[] = [
      { invoice_date: '2025-01-15', total: '1200.00', product: 'Widget' },
    ];

    const result = normalizeRows(rows, aliasedHeaders);
    expect(result).toHaveLength(1);
    expect(result[0]!.category).toBe('Widget');
    expect(result[0]!.amount).toBe('1200.00');
    expect(result[0]!.date).toBeInstanceOf(Date);
  });

  it('stores day-first dates correctly instead of swapping day and month', () => {
    const rows: ParsedRow[] = [
      { date: '23/03/1976', amount: '120.00', category: 'Revenue' },
      { date: '10/09/1982', amount: '65.48', category: 'Expenses' },
    ];
    const minHeaders = ['date', 'amount', 'category'];

    const result = normalizeRows(rows, minHeaders);
    expect(result[0]!.date.toISOString().slice(0, 10)).toBe('1976-03-23');
    // Proven day-first by the first row (day 23), so 10/09 must also be
    // read as 10 September, not swapped to October 9th
    expect(result[1]!.date.toISOString().slice(0, 10)).toBe('1982-09-10');
  });

  it('classifies parentCategory by amount sign when parent_category is absent but proven', () => {
    const rows: ParsedRow[] = [
      { date: '2025-01-15', amount: '1200.00', category: 'Revenue' },
      { date: '2025-01-16', amount: '-450.50', category: 'Office Supplies' },
    ];
    const minHeaders = ['date', 'amount', 'category'];

    const result = normalizeRows(rows, minHeaders);
    expect(result[0]!.parentCategory).toBe('Income');
    expect(result[0]!.amount).toBe('1200.00');
    expect(result[1]!.parentCategory).toBe('Expenses');
    expect(result[1]!.amount).toBe('450.50'); // stored as positive magnitude
  });

  it('leaves parentCategory null when there is no signal to classify by at all', () => {
    const rows: ParsedRow[] = [
      { date: '2025-01-15', amount: '1200.00', category: 'Revenue' },
      { date: '2025-01-16', amount: '450.50', category: 'Office Supplies' },
    ];
    const minHeaders = ['date', 'amount', 'category'];

    const result = normalizeRows(rows, minHeaders);
    expect(result[0]!.parentCategory).toBeNull();
    expect(result[1]!.parentCategory).toBeNull();
  });

  it('handles messy headers by normalizing', () => {
    const messyHeaders = ['Date', ' AMOUNT ', 'category'];
    const rows: ParsedRow[] = [
      { Date: '2025-01-15', ' AMOUNT ': '500', category: 'Revenue' },
    ];

    const result = normalizeRows(rows, messyHeaders);
    expect(result).toHaveLength(1);
    expect(result[0]!.amount).toBe('500');
    expect(result[0]!.date).toBeInstanceOf(Date);
  });
});
