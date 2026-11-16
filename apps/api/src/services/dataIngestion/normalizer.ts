import type { ParsedRow } from '../adapters/interface.js';
import { buildHeaderMap, detectDayFirst, parseDate, hasClassificationSignal, normalizeParentCategory } from './csvAdapter.js';

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

// A file can name the account type and still sign the amount, and the two
// readings disagree: financialEffect gives Expenses a sign of +1, so a negative
// row reduces costs, and a ledger export where every outflow is negative turns
// into an org whose every expense is a refund. What proves the file means
// direction rather than reduction is that nothing on that side is ever
// positive. Mixed signs are left alone: one positive row shows the file does
// tell a cost from a credit, so its negatives are real contra entries. Same
// shape as detectDayFirst, which also reads the whole column for proof and
// leaves genuinely ambiguous files on the existing behavior (DW-278).
function sidesSignedByDirection(
  rows: ParsedRow[],
  amountKey: string,
  parentCatKey: string,
): ReadonlySet<string> {
  const allNegative = new Map<string, boolean>();

  for (const row of rows) {
    const side = normalizeParentCategory(row[parentCatKey] ?? '');
    if (!side) continue;
    const amount = Number((row[amountKey] ?? '').trim().replace(/,/g, ''));
    // A zero points neither way. Counting it as non-negative would disqualify
    // the side and put the file back on the reading this exists to correct.
    if (amount === 0) continue;
    allNegative.set(side, (allNegative.get(side) ?? true) && amount < 0);
  }

  return new Set([...allNegative].filter(([, negative]) => negative).map(([side]) => side));
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
  const useSignConvention = !parentCatKey && hasClassificationSignal(rows, amountKey);
  const directionSigned = parentCatKey
    ? sidesSignedByDirection(rows, amountKey, parentCatKey)
    : new Set<string>();

  return rows.map((row) => {
    const dateStr = row[dateKey] ?? '';
    const amountStr = row[amountKey] ?? '';
    const categoryStr = row[categoryKey] ?? '';
    const numericAmount = Number(amountStr.trim().replace(/,/g, ''));

    let parentCategory: string | null;
    let amount: string;
    if (parentCatKey) {
      parentCategory = normalizeParentCategory(row[parentCatKey] ?? '');
      amount =
        parentCategory && directionSigned.has(parentCategory)
          ? Math.abs(numericAmount).toFixed(2)
          : amountStr.trim().replace(/,/g, '');
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
