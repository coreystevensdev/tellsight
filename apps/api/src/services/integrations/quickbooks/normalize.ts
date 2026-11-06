import type {
  NormalizedQbRow,
  QbLine,
  QbLinkedTxn,
  QbTransaction,
  QbTransactionType,
} from './types.js';

const EXPENSE_TYPES = new Set<QbTransactionType>([
  'Purchase',
  'Bill',
  'BillPayment',
  // Reduces what we owe a vendor, so it overstates Expenses the same way a
  // refund overstated Income below. The mirror fix, moving it to Income,
  // would count a vendor return as revenue and corrupt latestMonthlyRevenue,
  // computeYearOverYear, and computeSeasonalProjection. 'Other' would dodge
  // that and would even clear the margin and cash-flow side of this same
  // overstatement, both filter by parentCategory, but groupByCategory does
  // not, so computeTotals, computeCategoryBreakdowns, and the category-plan
  // variance would still count it exactly as they do today. That trades this
  // defect for a smaller one rather than removing it, so Expenses stays;
  // the overstatement itself is a known, separate defect.
  'VendorCredit',
]);

// CreditMemo and RefundReceipt hand money back to a customer. Same rule
// Square uses for its refunds (square/normalize.ts): never a negative sale,
// always a positive Expenses row, so the sign means one thing no matter which
// connector wrote the row. Category is 'Refunds', plural, matching Shopify
// (shopify/normalize.ts) and the curation test fixtures, both of which pin
// that spelling. Square alone writes the singular 'Refund' and nothing pins
// it; that mismatch predates this fix, so it stays a separate cleanup rather
// than something this change should touch.
const REFUND_TYPES = new Set<QbTransactionType>(['CreditMemo', 'RefundReceipt']);

const INCOME_TYPES = new Set<QbTransactionType>(['Invoice', 'Payment', 'SalesReceipt', 'Deposit']);

function getParentCategory(
  txnType: QbTransactionType,
  line: QbLine,
): 'Income' | 'Expenses' | 'Other' {
  if (EXPENSE_TYPES.has(txnType) || REFUND_TYPES.has(txnType)) return 'Expenses';
  if (INCOME_TYPES.has(txnType)) return 'Income';

  if (txnType === 'JournalEntry') {
    const posting = line.JournalEntryLineDetail?.PostingType;
    return posting === 'Credit' ? 'Income' : 'Expenses';
  }

  return 'Other';
}

// A SubTotal line repeats the sum of the lines above it, and a DescriptionOnly
// line carries text rather than money. Importing either one double-counts the
// transaction: sandbox invoice 130 is 275 + 12.75 + 47.50 with a fourth line of
// 335.25. Anything with no DetailType at all is kept, since we cannot tell what
// it is and dropping money silently is worse than counting it.
const AGGREGATE_DETAIL_TYPES = new Set(['SubTotalLineDetail', 'DescriptionOnly']);

function carriesItsOwnAmount(line: QbLine): boolean {
  return line.DetailType === undefined || !AGGREGATE_DETAIL_TYPES.has(line.DetailType);
}

function linksToIncomeType(links: QbLinkedTxn[] | undefined): boolean {
  return (links ?? []).some((link) => INCOME_TYPES.has(link.TxnType as QbTransactionType));
}

// Payment only: a LinkedTxn naming any INCOME_TYPES entity, the Invoice it
// settles or the Payment it batches out of Undeposited Funds, restates
// money that other transaction already recorded. Reads the root as well as
// every line since a lineless payment still needs an answer and the root is
// where it would carry one. Deposit asks the same question per line, below,
// since a deposit form routinely mixes an already-recorded line with new
// money in the same transaction.
function isAlreadyRecorded(tx: QbTransaction): boolean {
  if (linksToIncomeType(tx.LinkedTxn)) return true;
  return (tx.Line ?? []).some((line) => linksToIncomeType(line.LinkedTxn));
}

function getAccountRef(line: QbLine) {
  return (
    line.AccountBasedExpenseLineDetail?.AccountRef ??
    line.DepositLineDetail?.AccountRef ??
    line.JournalEntryLineDetail?.AccountRef ??
    line.SalesItemLineDetail?.ItemRef
  );
}

function getLabel(tx: QbTransaction): string | null {
  const entityName = tx.CustomerRef?.name ?? tx.VendorRef?.name ?? tx.EntityRef?.name;
  if (entityName) return entityName;
  if (tx.PrivateNote) return tx.PrivateNote;
  if (tx.DocNumber) return tx.DocNumber;
  return null;
}

// Shared by the TotalAmt fallback below and the UnappliedAmt path: both are
// "one row for the whole transaction, no account or item ref to categorize
// it by," they just disagree on which field holds the amount.
function uncategorizedRow(
  tx: QbTransaction,
  txnType: QbTransactionType,
  amount: number,
  parentCategory: 'Income' | 'Expenses' | 'Other',
): NormalizedQbRow {
  return {
    sourceType: 'quickbooks',
    sourceId: `${tx.Id}-0`,
    date: new Date(tx.TxnDate),
    amount: String(amount),
    // A refund's category and its parent are one decision, so the helper owns
    // both rather than letting a caller pass a parent that disagrees.
    category: REFUND_TYPES.has(txnType) ? 'Refunds' : 'Uncategorized',
    parentCategory,
    label: getLabel(tx),
    metadata: {
      qb_id: tx.Id,
      txnType,
      docNumber: tx.DocNumber ?? null,
      memo: tx.PrivateNote ?? null,
      accountCode: null,
    },
  };
}

export function normalizeTransaction(
  tx: QbTransaction,
  txnType: QbTransactionType,
): NormalizedQbRow[] {
  if (txnType === 'Payment') {
    // UnappliedAmt is what QuickBooks already netted out after applying
    // every LinkedTxn, so it catches a partially applied payment where a
    // plain linked/unlinked check can't: $400 applied out of $1,000 still
    // leaves $600 with no invoice behind it. Number() coerces first because
    // api.ts casts the API response with no runtime validation, so a
    // stringified amount must not fail the finite check and fall back to
    // the link rule, dropping that $600.
    const unapplied = Number(tx.UnappliedAmt);
    const total = Math.abs(tx.TotalAmt ?? NaN);
    // api.ts's unvalidated cast can hand back a missing TotalAmt just as
    // easily as a missing UnappliedAmt, so a NaN total is not evidence the
    // unapplied amount is out of range, it is an absent yardstick. Checking
    // unapplied <= NaN is always false, which used to fail a genuinely sane
    // value and turn a real $600 into a zero-amount row or no row at all.
    const isSane =
      Number.isFinite(unapplied) &&
      unapplied >= 0 &&
      (!Number.isFinite(total) || unapplied <= total);

    if (isSane && unapplied > 0) {
      return [uncategorizedRow(tx, txnType, unapplied, 'Income')];
    }
    // Zero alone isn't proof this payment settled something we can see:
    // QuickBooks can report it off a link we don't treat as income (a
    // Bill) or no link at all, and trusting it there is how a payment tied
    // to an expense loses its own money instead of landing as Income. An
    // out-of-range value (negative, or bigger than a known payment) is just
    // as untrustworthy. Either way, fall through to the same LinkedTxn rule
    // below that every other payment shape uses.
  }

  if (txnType === 'Payment' && isAlreadyRecorded(tx)) return [];

  const realLines = (tx.Line ?? []).filter(carriesItsOwnAmount);

  // A Deposit mixes "Select the payments" lines (LinkedTxn to the thing
  // that already recorded this money) with "Add funds" lines (new money,
  // a loan or owner contribution, with no record anywhere else). Dropping
  // only the linked lines, rather than the whole transaction the way
  // Payment does above, is what keeps a $5,000 owner loan swept into the
  // same deposit as a $500 payment from disappearing along with it. A root
  // link (checked below, only once no real line is left) is a different
  // question: an unlinked line is new money no matter what the root claims,
  // so a root link can never suppress a deposit that still has one.
  const lines =
    txnType === 'Deposit'
      ? realLines.filter((line) => !linksToIncomeType(line.LinkedTxn))
      : realLines;

  const label = getLabel(tx);
  const date = new Date(tx.TxnDate);
  const isRefund = REFUND_TYPES.has(txnType);

  if (lines.length === 0) {
    // A Deposit whose real lines all linked to income is fully recorded by
    // whatever they link to; that is different from never having a line to
    // begin with, and falling back to TotalAmt here would double-count it.
    if (txnType === 'Deposit' && realLines.length > 0) return [];

    // A lineless deposit, or one with nothing but an aggregate line, can
    // still carry the link on the transaction root instead of a line. Real
    // Intuit payloads were never observed doing this, every sample puts the
    // link on Line, but checking the root only here, after confirming there
    // is no real line left to report, is what keeps this from suppressing
    // a deposit that still has unlinked money in it.
    if (txnType === 'Deposit' && linksToIncomeType(tx.LinkedTxn)) return [];

    // No line items (a Payment), or nothing left after dropping aggregates
    // (an invoice whose only line is its subtotal): one synthetic row off
    // TotalAmt. Returning [] instead would lose the transaction entirely.
    return [
      uncategorizedRow(
        tx,
        txnType,
        Math.abs(tx.TotalAmt ?? 0),
        EXPENSE_TYPES.has(txnType) || REFUND_TYPES.has(txnType)
          ? 'Expenses'
          : INCOME_TYPES.has(txnType)
            ? 'Income'
            : 'Other',
      ),
    ];
  }

  return lines.map((line, index) => {
    const accountRef = getAccountRef(line);
    const category = isRefund ? 'Refunds' : (accountRef?.name ?? 'Uncategorized');
    const parentCategory = getParentCategory(txnType, line);
    // QuickBooks line Ids are 1-based and this index is 0-based, so a bare
    // String(index) collides with the Id of the line before it. That is what
    // made the upsert fail with "cannot affect row a second time". The prefix
    // keeps the generated ids out of the provider's numbering entirely.
    const lineId = line.Id ?? `i${index}`;

    return {
      sourceType: 'quickbooks',
      sourceId: `${tx.Id}-${lineId}`,
      date,
      amount: String(Math.abs(line.Amount)),
      category,
      parentCategory,
      label,
      metadata: {
        qb_id: tx.Id,
        txnType,
        docNumber: tx.DocNumber ?? null,
        memo: tx.PrivateNote ?? null,
        accountCode: accountRef?.value ?? null,
      },
    };
  });
}

export function normalizeTransactions(
  transactions: QbTransaction[],
  txnType: QbTransactionType,
): NormalizedQbRow[] {
  return transactions.flatMap((tx) => normalizeTransaction(tx, txnType));
}
