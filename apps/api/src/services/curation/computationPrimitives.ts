export interface DataRow {
  category: string;
  parentCategory?: string | null;
  date: Date;
  amount: string;
  label?: string | null;
  metadata?: unknown;
  [key: string]: unknown;
}

// Money earned or money spent. Charts work the same way (charts.ts) and
// csvAdapter.ts states it as the contract: a row reaches a revenue or expense
// view once its parentCategory is exactly one of these two.
export function isFinancialRow(row: DataRow): boolean {
  return row.parentCategory === 'Income' || row.parentCategory === 'Expenses';
}

// Classified, and classified as something that is not profit and loss. A
// Shopify product row carries inventory value, a QuickBooks Transfer moves cash
// between the owner's own accounts, a VendorCredit reduces what is owed. Each is
// a real figure that belongs on a balance sheet, and summing one into a category
// total reports stock on hand as though it were revenue.
//
// Null is deliberately not included here, and the difference matters. Null means
// nobody could classify the row, which happens to every row of a CSV that
// carries no parent_category column and no negative amounts. csvAdapter.ts warns
// on exactly that upload and promises only that "this data won't appear in your
// charts", so those rows still earn totals and trends. Treating null as
// non-financial would delete every insight for that upload instead.
export function isExplicitlyNonFinancial(row: DataRow): boolean {
  return row.parentCategory != null && !isFinancialRow(row);
}

export const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export function parseAmount(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// UTC, not local time: date values arrive from Drizzle/postgres-js as
// UTC-midnight instants, and the process timezone must not decide which
// calendar month a row lands in near a boundary.
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
