import type { SourceType } from 'shared/types';

export interface DataRow {
  category: string;
  parentCategory?: string | null;
  date: Date;
  amount: string;
  label?: string | null;
  metadata?: unknown;
  [key: string]: unknown;
}

export type FinancialSide = 'Income' | 'Expenses';

// Sources that can only ever report money coming in. Shopify pulls orders,
// refunds and products; Square pulls orders across locations; Stripe pulls
// payments. None can see an operating cost, so the only Expenses rows they write
// are refunds. QuickBooks, Xero and Plaid see both sides, and a CSV's columns are
// the owner's own choice, so none of those are listed.
// A Record rather than a set of the blind ones, so adding a source to
// sourceTypeSchema without classifying it is a type error rather than a silent
// default to "can see costs". Same reason ACTION_MUTATES is a Record in
// packages/shared/src/agent/proposal.ts.
const SEES_OPERATING_COST: Record<SourceType, boolean> = {
  csv: true,
  quickbooks: true,
  xero: true,
  plaid: true,
  shopify: false,
  square: false,
  stripe: false,
};

/**
 * True when at least one Expenses row came from a source that can see operating
 * costs. Refund-only expense data is an absence of cost data, and a margin
 * computed against it reads ~97% for a store whose real margin is a fifth of
 * that (DW-261). DW-252 already suppressed the zero case with that reasoning;
 * its `priorExpense <= 0` guard misses this one because a refund makes the
 * figure positive.
 *
 * Keyed on the source rather than on a ratio threshold: a genuine high-margin
 * services business exists and should not be suppressed, while a revenue-only
 * connector is knowably incapable of the data regardless of what its numbers
 * look like. A mixed org passes as soon as one accounting source contributes an
 * expense row, which is the correct answer for QuickBooks plus Shopify.
 */
export function hasCostVisibility(
  rows: readonly { sourceType?: string | null; parentCategory?: string | null }[],
): boolean {
  return rows.some((row) => {
    if (financialEffect(row)?.side !== 'Expenses') return false;
    // The row type stays permissive because SourceRow is a Pick that drops
    // sourceType and sourceRows.ts moves rows of that shape around this layer.
    // An absent or unrecognised source reads as cost-visible, which keeps this
    // predicate subtractive: it can only ever suppress what the guards before it
    // already allowed, never widen them.
    if (row.sourceType == null) return true;
    return SEES_OPERATING_COST[row.sourceType as SourceType] ?? true;
  });
}

// A contra entry reduces a side rather than adding to it: a vendor credit
// shrinks what is owed, so it belongs against Expenses without being one. The
// amount stays positive, as it is for every row a connector writes, and the
// parent category carries both the side and the direction.
//
// The sign could not carry it. A CSV with its own parent_category column stores
// amount verbatim (normalizer.ts:42-44), so a negative amount inside
// 'Expenses' already occurs and already means "as the bank exported it".
// charts.ts abs()es for exactly that, so one column would have had to mean
// magnitude to some readers and reduction to others with nothing on the row to
// say which.
const CONTRA_SIDE: Record<string, FinancialSide> = {
  IncomeContra: 'Income',
  ExpensesContra: 'Expenses',
};

export interface FinancialEffect {
  side: FinancialSide;
  /** +1 adds to that side's total, -1 reduces it. */
  sign: 1 | -1;
}

// The one place that decides what a parentCategory means. Every consumer reads
// this instead of comparing strings, so teaching the model a new value is one
// edit here rather than eight matching `else if` branches that can disagree.
// Null means the row is not profit and loss at all.
export function financialEffect(row: { parentCategory?: string | null }): FinancialEffect | null {
  const parent = row.parentCategory;
  if (parent === 'Income' || parent === 'Expenses') return { side: parent, sign: 1 };
  if (parent != null) {
    const side = CONTRA_SIDE[parent];
    if (side) return { side, sign: -1 };
  }
  return null;
}

// Money earned or money spent, including the entries that reduce either.
// Charts work the same way (charts.ts) and csvAdapter.ts states it as the
// contract: a row reaches a revenue or expense view once its parentCategory
// says which side it is on.
export function isFinancialRow(row: DataRow): boolean {
  return financialEffect(row) !== null;
}

// Classified, and classified as something that is not profit and loss. A
// Shopify product row carries inventory value and a QuickBooks Transfer moves
// cash between the owner's own accounts. Each is a real figure that belongs on a
// balance sheet, and summing one into a category total reports stock on hand as
// though it were revenue. A contra entry is not one of these: it affects a side,
// so financialEffect claims it and this returns false for it.
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
