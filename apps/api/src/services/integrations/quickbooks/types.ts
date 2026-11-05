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
  // Inherited from the base Transaction type: Intuit's .NET SDK class
  // reference lists it on every entity, "A linked (related) transaction...
  // (Inherited from Transaction.)", the same inheritance TxnDate, DocNumber
  // and TotalAmt use above. Confirmed, not a guess, though every Intuit
  // sample (the PHP CRUD sample, the .NET sample, the Postman collection)
  // puts the actual link on Line instead, which is why Line is the path
  // that fires in practice.
  LinkedTxn?: QbLinkedTxn[];
  // Payment-only. "The amount that has not been applied to pay amounts
  // owed for sales transactions" (Intuit's Payment reference). Non-QB-writable,
  // QuickBooks computes and returns it, so normalize.ts only ever reads it.
  // Nets out whatever LinkedTxn applied, which is what makes a partially
  // applied payment answerable without re-deriving the math ourselves.
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
