export interface QbRef {
  value: string;
  name?: string;
}

// What Intuit calls applying one transaction against another: a Payment
// settling an Invoice, a Deposit batching a Payment out of Undeposited
// Funds. Confirmed on Payment.Line and Deposit.Line in the QBO API
// reference (developer.intuit.com/.../all-entities/payment, .../deposit).
export interface QbLinkedTxn {
  TxnId: string;
  TxnType: string;
}

export interface QbLine {
  Id?: string;
  Amount: number;
  DetailType?: string;
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QbRef;
  };
  SalesItemLineDetail?: {
    ItemRef?: QbRef;
    TaxCodeRef?: QbRef;
  };
  DepositLineDetail?: {
    AccountRef?: QbRef;
  };
  JournalEntryLineDetail?: {
    PostingType?: 'Debit' | 'Credit';
    AccountRef?: QbRef;
  };
  LinkedTxn?: QbLinkedTxn[];
  Description?: string;
}

export interface QbTransaction {
  Id: string;
  TxnDate: string;
  DocNumber?: string;
  PrivateNote?: string;
  TotalAmt?: number;
  Line?: QbLine[];
  // Not documented at the transaction root for Payment or Deposit, Intuit's
  // reference only shows Line.LinkedTxn for those two. Kept here anyway: a
  // fully-applied Payment can arrive with no Line array at all (TotalAmt-only),
  // and that shape needs somewhere to carry the link other than a line that
  // does not exist. Invoice does document a root-level LinkedTxn (the reverse
  // direction, which Payments paid it), so the shape has real precedent.
  LinkedTxn?: QbLinkedTxn[];

  CustomerRef?: QbRef;
  VendorRef?: QbRef;
  EntityRef?: QbRef;

  MetaData?: {
    CreateTime?: string;
    LastUpdatedTime?: string;
  };
}

export type QbTransactionType =
  | 'Purchase'
  | 'Bill'
  | 'BillPayment'
  | 'VendorCredit'
  | 'Invoice'
  | 'Payment'
  | 'SalesReceipt'
  | 'Deposit'
  | 'CreditMemo'
  | 'RefundReceipt'
  | 'JournalEntry'
  | 'Transfer'
  | 'Estimate';

export interface NormalizedQbRow {
  sourceType: 'quickbooks';
  sourceId: string;
  date: Date;
  amount: string;
  category: string;
  parentCategory: 'Income' | 'Expenses' | 'Other';
  label: string | null;
  metadata: {
    qb_id: string;
    txnType: QbTransactionType;
    docNumber: string | null;
    memo: string | null;
    accountCode: string | null;
  };
}
