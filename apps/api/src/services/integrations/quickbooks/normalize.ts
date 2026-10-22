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
  'VendorCredit',
]);

const INCOME_TYPES = new Set<QbTransactionType>([
  'Invoice',
  'Payment',
  'SalesReceipt',
  'Deposit',
  'CreditMemo',
  'RefundReceipt',
]);

function getParentCategory(
  txnType: QbTransactionType,
  line: QbLine,
): 'Income' | 'Expenses' | 'Other' {
  if (EXPENSE_TYPES.has(txnType)) return 'Expenses';
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

export function normalizeTransaction(
  tx: QbTransaction,
  txnType: QbTransactionType,
): NormalizedQbRow[] {
  const lines = (tx.Line ?? []).filter(carriesItsOwnAmount);
  const label = getLabel(tx);
  const date = new Date(tx.TxnDate);

  // No line items (a Payment), or nothing left after dropping aggregates (an
  // invoice whose only line is its subtotal): one synthetic row off TotalAmt.
  // Returning [] instead would lose the transaction entirely.
  if (lines.length === 0) {
    return [
      {
        sourceType: 'quickbooks',
        sourceId: `${tx.Id}-0`,
        date,
        amount: String(Math.abs(tx.TotalAmt ?? 0)),
        category: 'Uncategorized',
        parentCategory: EXPENSE_TYPES.has(txnType)
          ? 'Expenses'
          : INCOME_TYPES.has(txnType)
            ? 'Income'
            : 'Other',
        label,
        metadata: {
          qb_id: tx.Id,
          txnType,
          docNumber: tx.DocNumber ?? null,
          memo: tx.PrivateNote ?? null,
          accountCode: null,
        },
      },
    ];
  }

  return lines.map((line, index) => {
    const accountRef = getAccountRef(line);
    const category = accountRef?.name ?? 'Uncategorized';
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
