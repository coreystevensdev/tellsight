import { parse } from 'csv-parse/sync';
import {
  CSV_REQUIRED_COLUMNS,
  CSV_OPTIONAL_COLUMNS,
  CSV_MAX_ROWS,
} from 'shared/constants';
import type {
  ParseResult,
  ValidationResult,
  ColumnValidationError,
  ParsedRow,
} from '../adapters/index.js';

const ALL_KNOWN_COLUMNS = [...CSV_REQUIRED_COLUMNS, ...CSV_OPTIONAL_COLUMNS];

// Common column names from other tools' exports (QuickBooks, Shopify, generic
// e-commerce dumps) that map onto our canonical schema. Checked only when the
// canonical name itself isn't present.
const COLUMN_ALIASES: Record<string, readonly string[]> = {
  date: ['invoice_date', 'order_date', 'transaction_date', 'txn_date', 'posted_date'],
  amount: ['total', 'total_amount', 'price', 'cost', 'value', 'line_amount'],
  category: ['product', 'product_name', 'item', 'sku', 'stock_code', 'expense_category'],
  label: ['description', 'memo', 'notes', 'name'],
  parent_category: ['group', 'account_type'],
};

function resolveColumn(canonical: string, normalizedHeaders: string[]): string | undefined {
  if (normalizedHeaders.includes(canonical)) return canonical;
  return (COLUMN_ALIASES[canonical] ?? []).find((alias) => normalizedHeaders.includes(alias));
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

// Reject garbage that V8's Date constructor would accept (e.g. "hello 1", "true")
const DATE_SHAPE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;

function isValidDate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || !DATE_SHAPE.test(trimmed)) return false;

  const d = new Date(trimmed);
  return !isNaN(d.getTime());
}

function isValidAmount(value: string): boolean {
  const cleaned = value.trim().replace(/,/g, '');
  if (!cleaned) return false;
  return !isNaN(Number(cleaned));
}

function validateHeaders(headers: string[]): ValidationResult {
  const normalized = headers.map(normalizeHeader);
  const errors: ColumnValidationError[] = [];

  for (const required of CSV_REQUIRED_COLUMNS) {
    if (!resolveColumn(required, normalized)) {
      errors.push({
        column: required,
        message: `We expected a column named '${required}'. Your file has columns: ${headers.join(', ')}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateRowValues(
  rows: ParsedRow[],
  headerMap: Map<string, string>,
): { errors: ColumnValidationError[]; skippedRows: number[] } {
  const errors: ColumnValidationError[] = [];
  const skippedRows: number[] = [];

  const dateKey = headerMap.get('date')!;
  const amountKey = headerMap.get('amount')!;
  const categoryKey = headerMap.get('category')!;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowNum = i + 2; // +2 because row 1 is header, data starts at row 2
    let rowHasError = false;

    const dateVal = row[dateKey] ?? '';
    const amountVal = row[amountKey] ?? '';
    const catValue = (row[categoryKey] ?? '').trim();

    if (!isValidDate(dateVal)) {
      errors.push({
        column: 'date',
        row: rowNum,
        message: `Row ${rowNum}: We couldn't read '${dateVal}' as a date. Expected format: YYYY-MM-DD (e.g., 2025-01-15)`,
      });
      rowHasError = true;
    }

    if (!isValidAmount(amountVal)) {
      errors.push({
        column: 'amount',
        row: rowNum,
        message: `Row ${rowNum}: We couldn't read '${amountVal}' as an amount. Expected a number (e.g., 1200.00)`,
      });
      rowHasError = true;
    }
    if (!catValue) {
      errors.push({
        column: 'category',
        row: rowNum,
        message: `Row ${rowNum}: Category is empty. Every row needs a category value.`,
      });
      rowHasError = true;
    }

    if (rowHasError) skippedRows.push(rowNum);
  }

  return { errors, skippedRows };
}

/**
 * Builds a map from normalized column names to the original header strings.
 * csv-parse uses the original header as the key in each row object, so we
 * need this mapping to look up values by normalized name.
 */
function buildHeaderMap(rawHeaders: string[]): Map<string, string> {
  const normalizedToRaw = new Map<string, string>();
  for (const h of rawHeaders) {
    normalizedToRaw.set(normalizeHeader(h), h);
  }
  const normalizedHeaders = [...normalizedToRaw.keys()];

  const map = new Map<string, string>();
  for (const canonical of ALL_KNOWN_COLUMNS) {
    const matched = resolveColumn(canonical, normalizedHeaders);
    if (matched) map.set(canonical, normalizedToRaw.get(matched)!);
  }
  return map;
}

export const csvAdapter = {
  parse(buffer: Buffer): ParseResult {
    const content = stripBom(buffer.toString('utf-8'));

    if (!content.trim()) {
      return { headers: [], rows: [], rowCount: 0, warnings: ['This file appears to be empty. Download our sample template to see the expected format.'] };
    }

    const records: ParsedRow[] = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    // csv-parse handles quoted headers correctly (e.g. "Revenue, Q1")
    //, naive split(',') would break on those
    let rawHeaders: string[];
    if (records.length > 0) {
      rawHeaders = Object.keys(records[0]!);
    } else {
      const headerRows: string[][] = parse(content, {
        columns: false,
        to: 1,
        skip_empty_lines: true,
        trim: true,
      });
      rawHeaders = headerRows[0] ?? [];
    }

    if (records.length === 0) {
      return {
        headers: rawHeaders,
        rows: [],
        rowCount: 0,
        warnings: ['File has headers but no data rows. Download our sample template to see the expected format.'],
      };
    }

    if (records.length > CSV_MAX_ROWS) {
      return {
        headers: rawHeaders,
        rows: [],
        rowCount: records.length,
        warnings: [`File has ${records.length.toLocaleString()} rows, which exceeds our limit of ${CSV_MAX_ROWS.toLocaleString()}. Try splitting your data into smaller files.`],
      };
    }

    const warnings: string[] = [];
    const headerMap = buildHeaderMap(rawHeaders);
    const headerValidation = this.validate(rawHeaders);

    if (!headerValidation.valid) {
      // header-level failures are fatal, can't validate rows without the right columns
      return { headers: rawHeaders, rows: [], rowCount: records.length, warnings: [] };
    }

    const { skippedRows } = validateRowValues(records, headerMap);
    const failRate = records.length > 0 ? skippedRows.length / records.length : 0;

    if (failRate > 0.5) {
      // >50% of sampled rows failed, reject entirely
      return { headers: rawHeaders, rows: [], rowCount: records.length, warnings: [] };
    }

    if (skippedRows.length > 0) {
      const preview = skippedRows.slice(0, 5).join(', ');
      const suffix = skippedRows.length > 5 ? ', ...' : '';
      warnings.push(
        `${skippedRows.length} rows skipped: validation errors in rows ${preview}${suffix}`,
      );
    }

    // Filter out bad rows from the result set
    const skippedSet = new Set(skippedRows);
    const validRows = records.filter((_, i) => !skippedSet.has(i + 2));

    return {
      headers: rawHeaders,
      rows: validRows,
      rowCount: records.length,
      warnings,
    };
  },

  validate(headers: string[]): ValidationResult {
    return validateHeaders(headers);
  },
};

// Re-export helpers for testing
export { stripBom, normalizeHeader, isValidDate, isValidAmount, buildHeaderMap };
