import { describe, it, expect } from 'vitest';
import { csvAdapter, stripBom, normalizeHeader, isValidDate, isValidAmount, detectDayFirst, parseDate, hasClassificationSignal, normalizeParentCategory } from './csvAdapter.js';
import {
  validCsv,
  validCsvWithOptionals,
  aliasedColumns,
  signedAmountsNoParentCategory,
  parentCategorySynonyms,
  partiallyUnrecognizedParentCategory,
  dayFirstDates,
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
    // no parent_category and no negative amounts, can't classify Income vs Expenses
    expect(result.warnings[0]).toContain("couldn't tell which rows are income vs. expenses");
    expect(result.rows[0]).toMatchObject({ date: '2025-01-15', amount: '1200.00', category: 'Revenue' });
  });

  it('includes optional columns when present', () => {
    const result = csvAdapter.parse(toBuffer(validCsvWithOptionals));
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toHaveProperty('label', 'Monthly sales');
    expect(result.rows[0]).toHaveProperty('parent_category', 'Income');
  });

  it('accepts aliased column names from other tools (invoice_date, total, product)', () => {
    const result = csvAdapter.parse(toBuffer(aliasedColumns));
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ invoice_date: '2025-01-15', total: '1200.00', product: 'Widget' });
  });

  it('accepts day-first (European) dates instead of rejecting most of the file', () => {
    const result = csvAdapter.parse(toBuffer(dayFirstDates));
    expect(result.rows).toHaveLength(3);
  });

  it('does not warn when a negative amount proves the expense-sign convention', () => {
    const result = csvAdapter.parse(toBuffer(signedAmountsNoParentCategory));
    expect(result.warnings).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
  });

  it('does not warn when parent_category uses recognized synonyms (Revenue/Cost)', () => {
    const result = csvAdapter.parse(toBuffer(parentCategorySynonyms));
    expect(result.warnings).toHaveLength(0);
    expect(result.rows).toHaveLength(3);
  });

  it('warns about the specific rows with an unrecognized parent_category value', () => {
    const result = csvAdapter.parse(toBuffer(partiallyUnrecognizedParentCategory));
    expect(result.rows).toHaveLength(3); // still uploads, just flags the 2 that won't chart
    expect(result.warnings[0]).toContain('2 rows have a parent_category value');
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

  it('accepts aliased column names in place of canonical ones', () => {
    const result = csvAdapter.validate(['invoice_date', 'total', 'product']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('still reports the canonical column name when no alias matches either', () => {
    const result = csvAdapter.validate(['date', 'amount']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.column).toBe('category');
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

  it('detectDayFirst proves day-first when a segment exceeds 12', () => {
    expect(detectDayFirst(['23/03/1976', '10/09/1982'])).toBe(true);
  });

  it('detectDayFirst proves month-first when the second segment exceeds 12', () => {
    expect(detectDayFirst(['03/23/1976', '09/10/1982'])).toBe(false);
  });

  it('detectDayFirst defaults to month-first when genuinely ambiguous', () => {
    expect(detectDayFirst(['03/10/2012', '01/05/2020'])).toBe(false);
  });

  it('parseDate reinterprets D/M/Y as day-first without silently swapping', () => {
    const parsed = parseDate('23/03/1976', true);
    expect(parsed?.toISOString().slice(0, 10)).toBe('1976-03-23');
  });

  it('parseDate keeps M/D/Y interpretation when dayFirst is false', () => {
    const parsed = parseDate('03/10/2012', false);
    expect(parsed?.toISOString().slice(0, 10)).toBe('2012-03-10');
  });

  it('parseDate returns null for garbage regardless of dayFirst', () => {
    expect(parseDate('not-a-date', true)).toBeNull();
    expect(parseDate('', false)).toBeNull();
  });

  it('hasClassificationSignal is true when a parent_category value is recognized', () => {
    const rows = [{ amount: '100.00', parent_category: 'Income' }];
    expect(hasClassificationSignal(rows, 'amount', 'parent_category')).toBe(true);
  });

  it('hasClassificationSignal is false when parent_category exists but no value is recognized', () => {
    const rows = [{ amount: '100.00', parent_category: 'N/A' }];
    expect(hasClassificationSignal(rows, 'amount', 'parent_category')).toBe(false);
  });

  it('hasClassificationSignal is true when any amount is negative and no parent_category', () => {
    const rows = [{ amount: '100.00' }, { amount: '-50.00' }];
    expect(hasClassificationSignal(rows, 'amount')).toBe(true);
  });

  it('hasClassificationSignal is false when all amounts are non-negative and no parent_category', () => {
    const rows = [{ amount: '100.00' }, { amount: '50.00' }];
    expect(hasClassificationSignal(rows, 'amount')).toBe(false);
  });

  it('normalizeParentCategory maps case-insensitive synonyms to canonical values', () => {
    expect(normalizeParentCategory('income')).toBe('Income');
    expect(normalizeParentCategory('Revenue')).toBe('Income');
    expect(normalizeParentCategory('SALES')).toBe('Income');
    expect(normalizeParentCategory('expenses')).toBe('Expenses');
    expect(normalizeParentCategory('Cost')).toBe('Expenses');
    expect(normalizeParentCategory('N/A')).toBeNull();
    expect(normalizeParentCategory('')).toBeNull();
  });

  it('isValidAmount handles numbers with commas', () => {
    expect(isValidAmount('1,200.00')).toBe(true);
    expect(isValidAmount('1200')).toBe(true);
    expect(isValidAmount('twelve')).toBe(false);
    expect(isValidAmount('')).toBe(false);
  });
});
