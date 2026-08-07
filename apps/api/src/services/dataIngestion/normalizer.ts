import type { ParsedRow } from '../adapters/index.js';
import { buildHeaderMap, detectDayFirst, parseDate, hasClassificationSignal } from './csvAdapter.js';

/**
 * Shape that matches data_rows insert requirements. The normalizer
 * transforms raw CSV strings into typed values the DB layer expects.
 * orgId, datasetId, and sourceType are assigned at persistence time,
 * not here.
 */
export interface NormalizedRow {
  category: string;
  parentCategory: string | null;
  date: Date;
  amount: string;
  label: string | null;
  metadata: null;
}

export function normalizeRows(rows: ParsedRow[], rawHeaders: string[]): NormalizedRow[] {
  const headerMap = buildHeaderMap(rawHeaders);

  const dateKey = headerMap.get('date')!;
  const amountKey = headerMap.get('amount')!;
  const categoryKey = headerMap.get('category')!;
  const labelKey = headerMap.get('label');
  const parentCatKey = headerMap.get('parent_category');
  const dayFirst = detectDayFirst(rows.map((r) => r[dateKey] ?? ''));
  // No parent_category column: fall back to amount sign (negative = expense,
  // a common bank/ledger export convention), but only once the file proves
  // it uses that convention somewhere, otherwise leave rows unclassified
  // rather than guessing every row is Income.
  const useSignConvention = !parentCatKey && hasClassificationSignal(false, rows, amountKey);

  return rows.map((row) => {
    const dateStr = row[dateKey] ?? '';
    const amountStr = row[amountKey] ?? '';
    const categoryStr = row[categoryKey] ?? '';
    const numericAmount = Number(amountStr.trim().replace(/,/g, ''));

    let parentCategory: string | null;
    let amount: string;
    if (parentCatKey) {
      parentCategory = row[parentCatKey]?.trim() || null;
      amount = amountStr.trim().replace(/,/g, '');
    } else if (useSignConvention) {
      parentCategory = numericAmount < 0 ? 'Expenses' : 'Income';
      amount = Math.abs(numericAmount).toFixed(2);
    } else {
      parentCategory = null;
      amount = amountStr.trim().replace(/,/g, '');
    }

    return {
      category: categoryStr.trim(),
      parentCategory,
      // rows reaching here already passed isValidDate() with the same
      // dayFirst interpretation, so this can't be null
      date: parseDate(dateStr, dayFirst)!,
      amount,
      label: labelKey ? (row[labelKey]?.trim() || null) : null,
      metadata: null,
    };
  });
}
