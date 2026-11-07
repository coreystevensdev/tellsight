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
  // Inherited onto every entity, but every real Intuit payload puts the
  // actual link on Line instead, so normalize.ts checks both.
  LinkedTxn?: QbLinkedTxn[];
  // Payment-only, QuickBooks-computed. Nets out whatever LinkedTxn already
  // applied, which is what answers a partially applied payment.
  UnappliedAmt?: number;

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
  parentCategory: 'Income' | 'Expenses' | 'ExpensesContra' | 'Other';
  label: string | null;
  metadata: {
    qb_id: string;
    txnType: QbTransactionType;
    docNumber: string | null;
    memo: string | null;
    accountCode: string | null;
  };
}
