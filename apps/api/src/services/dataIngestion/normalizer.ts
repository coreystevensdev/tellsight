import type { ParsedRow } from '../adapters/index.js';
import { buildHeaderMap } from './csvAdapter.js';

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

  return rows.map((row) => {
    const dateStr = row[dateKey] ?? '';
    const amountStr = row[amountKey] ?? '';
    const categoryStr = row[categoryKey] ?? '';

    return {
      category: categoryStr.trim(),
      parentCategory: parentCatKey ? (row[parentCatKey]?.trim() || null) : null,
      date: new Date(dateStr.trim()),
      amount: amountStr.trim().replace(/,/g, ''),
      label: labelKey ? (row[labelKey]?.trim() || null) : null,
      metadata: null,
    };
  });
}
