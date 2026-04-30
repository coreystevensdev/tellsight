import { describe, it, expect } from 'vitest';
import { csvAdapter, stripBom, normalizeHeader, isValidDate, isValidAmount } from './csvAdapter.js';
import {
  validCsv,
  validCsvWithOptionals,
  missingColumn,
  invalidDates,
  invalidAmounts,
  emptyFile,
  headerOnly,
  bomPrefixed,
  messyHeaders,
  trailingNewlines,
  partiallyValid,
  mostlyInvalid,
  quotedHeaders,
} from '../../test/fixtures/csvFiles.js';

function toBuffer(content: string): Buffer {
  return Buffer.from(content, 'utf-8');
}

describe('csvAdapter.parse', () => {
  it('parses valid CSV with all required columns', () => {
    const result = csvAdapter.parse(toBuffer(validCsv));
    expect(result.rows).toHaveLength(3);
    expect(result.rowCount).toBe(3);
    expect(result.headers).toEqual(['date', 'amount', 'category']);
    expect(result.warnings).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ date: '2025-01-15', amount: '1200.00', category: 'Revenue' });
  });

  it('includes optional columns when present', () => {
    const result = csvAdapter.parse(toBuffer(validCsvWithOptionals));
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toHaveProperty('label', 'Monthly sales');
    expect(result.rows[0]).toHaveProperty('parent_category', 'Income');
  });

  it('returns validation errors for missing required columns', () => {
    const result = csvAdapter.parse(toBuffer(missingColumn));
    // header validation fails, so rows are empty
    expect(result.rows).toHaveLength(0);

    const validation = csvAdapter.validate(['date', 'category']);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]!.column).toBe('amount');
    expect(validation.errors[0]!.message).toContain('We expected');
  });

  it('returns row-specific errors for invalid dates', () => {
    const result = csvAdapter.parse(toBuffer(invalidDates));
    // both rows have bad dates, but only 2 rows total, so >50% fail = rejected
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(2);
  });

  it('returns row-specific errors for invalid amounts', () => {
    const result = csvAdapter.parse(toBuffer(invalidAmounts));
    // both rows bad → >50% fail = rejected
    expect(result.rows).toHaveLength(0);
  });

  it('returns warning for empty file', () => {
    const result = csvAdapter.parse(toBuffer(emptyFile));
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
    expect(result.warnings[0]).toContain('empty');
  });

  it('returns warning for header-only file', () => {
    const result = csvAdapter.parse(toBuffer(headerOnly));
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
    expect(result.warnings[0]).toContain('no data rows');
  });

  it('handles BOM marker', () => {
    const result = csvAdapter.parse(toBuffer(bomPrefixed));
    expect(result.rows).toHaveLength(1);
    expect(result.headers[0]).toBe('date'); // BOM stripped
  });

  it('handles case-insensitive column matching', () => {
    const result = csvAdapter.parse(toBuffer(messyHeaders));
    expect(result.rows).toHaveLength(1);
    // headers are raw (original), validation normalizes internally
    const validation = csvAdapter.validate(result.headers);
    expect(validation.valid).toBe(true);
  });

  it('handles trailing newlines', () => {
    const result = csvAdapter.parse(toBuffer(trailingNewlines));
    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
  });

  it('supports partial success (some bad rows, <50%)', () => {
    const result = csvAdapter.parse(toBuffer(partiallyValid));
    // 5 rows total, 2 bad (date and amount) → 40% fail rate, below 50% threshold
    expect(result.rows.length).toBeLessThan(5);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('rows skipped');
  });

  it('rejects when >50% of rows fail', () => {
    const result = csvAdapter.parse(toBuffer(mostlyInvalid));
    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(3);
  });

  it('handles quoted headers containing commas', () => {
    const result = csvAdapter.parse(toBuffer(quotedHeaders));
    expect(result.headers).toContain('Revenue, Q1');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!['Revenue, Q1']).toBe('5000.00');
  });
});

describe('csvAdapter.validate', () => {
  it('accepts valid headers', () => {
    const result = csvAdapter.validate(['date', 'amount', 'category']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects missing required column', () => {
    const result = csvAdapter.validate(['date', 'category']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.column).toBe('amount');
  });

  it('accepts with extra columns', () => {
    const result = csvAdapter.validate(['date', 'amount', 'category', 'extra_col']);
    expect(result.valid).toBe(true);
  });
});

describe('helper functions', () => {
  it('stripBom removes BOM', () => {
    expect(stripBom('\uFEFFhello')).toBe('hello');
    expect(stripBom('hello')).toBe('hello');
  });

  it('normalizeHeader trims and lowercases', () => {
    expect(normalizeHeader(' Date ')).toBe('date');
    expect(normalizeHeader('AMOUNT')).toBe('amount');
  });

  it('isValidDate recognizes ISO dates', () => {
    expect(isValidDate('2025-01-15')).toBe(true);
    expect(isValidDate('not-a-date')).toBe(false);
    expect(isValidDate('')).toBe(false);
  });

  it('isValidAmount handles numbers with commas', () => {
    expect(isValidAmount('1,200.00')).toBe(true);
    expect(isValidAmount('1200')).toBe(true);
    expect(isValidAmount('twelve')).toBe(false);
    expect(isValidAmount('')).toBe(false);
  });
});
