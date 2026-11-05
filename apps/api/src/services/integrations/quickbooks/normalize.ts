import type {
  NormalizedQbRow,
  QbLine,
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

const INCOME_TYPES = new Set<QbTransactionType>([
  'Invoice',
  'Payment',
  'SalesReceipt',
  'Deposit',
]);

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

// Reads LinkedTxn from the transaction root as well as every line (see
// QbTransaction.LinkedTxn in types.ts for the citation): a Payment with no
// Line array still needs an answer, and the root is where it would carry one.
function linkedTxnTypes(tx: QbTransaction): Set<string> {
  const types = new Set<string>();
  for (const link of tx.LinkedTxn ?? []) types.add(link.TxnType);
  for (const line of tx.Line ?? []) {
    for (const link of line.LinkedTxn ?? []) types.add(link.TxnType);
  }
  return types;
}

function linksToIncome(tx: QbTransaction): boolean {
  const linked = linkedTxnTypes(tx);
  for (const incomeType of INCOME_TYPES) {
    if (linked.has(incomeType)) return true;
  }
  return false;
}

// A Payment or Deposit whose LinkedTxn names any INCOME_TYPES entity, the
// Invoice it settles, the Payment it batches out of Undeposited Funds, even
// a SalesReceipt, restates money that other transaction already recorded.
// Decided transaction-wide, before the line-count branch below picks a
// shape, so a lineless payment and a lined one get the same answer.
function isAlreadyRecorded(tx: QbTransaction, txnType: QbTransactionType): boolean {
  if (txnType !== 'Payment' && txnType !== 'Deposit') return false;
  return linksToIncome(tx);
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
  const entityName =
    tx.CustomerRef?.name ?? tx.VendorRef?.name ?? tx.EntityRef?.name;
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
  // UnappliedAmt is the net amount QuickBooks already computed after netting
  // out whatever LinkedTxn applied, so it gets a partially applied payment
  // right where a plain linked/unlinked check can't: $400 applied out of a
  // $1,000 payment still leaves $600 with no invoice behind it, and the
  // linked/unlinked check alone would call the whole payment settled. Only
  // Payment carries this field; falls back to the LinkedTxn check below when
  // it's absent rather than assuming every payload has it.
  if (txnType === 'Payment' && Number.isFinite(tx.UnappliedAmt)) {
    const unapplied = Math.abs(tx.UnappliedAmt!);
    return unapplied === 0 ? [] : [uncategorizedRow(tx, txnType, unapplied, 'Income')];
  }

  if (isAlreadyRecorded(tx, txnType)) return [];

  const lines = (tx.Line ?? []).filter(carriesItsOwnAmount);
  const label = getLabel(tx);
  const date = new Date(tx.TxnDate);
  const isRefund = REFUND_TYPES.has(txnType);

  // No line items (a Payment), or nothing left after dropping aggregates (an
  // invoice whose only line is its subtotal): one synthetic row off TotalAmt.
  // Returning [] instead would lose the transaction entirely.
  if (lines.length === 0) {
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
    const category = isRefund ? 'Refunds' : accountRef?.name ?? 'Uncategorized';
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
