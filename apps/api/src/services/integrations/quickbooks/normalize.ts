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
  const lines = tx.Line ?? [];
  const label = getLabel(tx);
  const date = new Date(tx.TxnDate);

  // transactions without line items (e.g., Payment) get a single synthetic row
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
    const lineId = line.Id ?? String(index);

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
