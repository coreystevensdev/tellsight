import type { SourceType } from 'shared/types';

export interface DataRow {
  category: string;
  parentCategory?: string | null;
  date: Date;
  amount: string;
  label?: string | null;
  // Declared, rather than reached through the index signature, so the curation
  // layer sees a string. label is free text that falls back to a memo or a doc
  // number; counterparty is the groupable one, which is the whole reason the
  // column was separated (DW-280).
  counterparty?: string | null;
  // Declared for the same reason, and it was always being read: both
  // cost-visibility predicates below key on it, and reaching it through the
  // index signature typed it `unknown` and made a weak-type parameter asking
  // only for `sourceType` share no properties with this interface at all.
  sourceType?: string | null;
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

/**
 * Whether one named source is structurally incapable of reporting operating
 * costs. False for anything unrecognised, which keeps every caller subtractive:
 * a connector added without classifying it is never accused of blindness.
 */
export function isCostBlindSource(sourceType: string | null | undefined): boolean {
  if (sourceType == null) return false;
  return SEES_OPERATING_COST[sourceType as SourceType] === false;
}

/**
 * The connectors feeding this dataset, when **every one of them** is
 * revenue-only. Empty otherwise.
 *
 * Deliberately a different question from `hasCostVisibility`, which asks
 * whether a usable expense row exists. That one is false for two unrelated
 * reasons, and the owner needs them told apart:
 *
 *   - a cost-visible source that simply has no expenses in it yet, where the
 *     answer is to add the data, and
 *   - a source that structurally cannot report expenses, where no amount of
 *     data fixes it and the answer is a different connector.
 *
 * Only the second is DW-279, and it is the one the product currently stays
 * silent about: a Shopify-only org produced 41 stats, more than the CSV org it
 * was measured against, and an eight-insight digest made entirely of totals and
 * averages. Nothing said the interesting half was never computable.
 *
 * Returns the names rather than a boolean because the message has to be
 * actionable: "Shopify only reports money coming in" is advice, "some insights
 * are unavailable" is not.
 */
export function costBlindSources(
  rows: readonly { sourceType?: string | null }[],
): string[] {
  const present = new Set<string>();
  for (const row of rows) {
    // An absent source reads as cost-visible for the same reason it does above,
    // and bailing on the first one keeps this subtractive: one unrecognised row
    // reports nothing rather than accusing a connector that may be fine.
    if (row.sourceType == null) return [];
    present.add(row.sourceType);
  }

  const blind = [...present].filter(isCostBlindSource);
  // All of them, not any: one QuickBooks row alongside Shopify means the costs
  // are visible and there is nothing to warn about.
  return blind.length > 0 && blind.length === present.size ? blind.sort() : [];
}

/**
 * The insights that need both sides of the ledger, so a revenue-only dataset
 * cannot produce them.
 *
 * Hand-maintained, which is a liability, so `costBlindInsights.test.ts` runs
 * `computeStats` over a revenue-only fixture and asserts that exactly these are
 * absent and the commodity stats survive. Adding a stat type that needs costs
 * without adding it here fails that test rather than quietly shipping a promise
 * the dataset cannot keep.
 *
 * `cash_flow` is deliberately **not** here, and finding out why is what that
 * test was worth writing for. DW-279 listed it alongside these two off a
 * production probe, but that dataset was 48 rows and `cash_flow` was absent for
 * want of months rather than want of costs. Given twelve months it computes
 * perfectly happily for a Shopify-only org, netting sales against refunds and
 * calling the result cash flow. So it is not unavailable, it is wrong, which is
 * the DW-261 shape for a different stat and a bigger change than this one.
 * Recorded as DW-295 rather than fixed here, because suppressing a stat that
 * currently renders is a product call.
 */
export const COST_BLIND_INSIGHTS = ['margin_trend', 'break_even'] as const;

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
