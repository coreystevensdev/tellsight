// Xero returns money and dates as strings in JSON ("49.90",
// "/Date(1401062400000+0000)/") while its own SDKs type them as numbers and
// Dates. api.ts casts the response with no runtime validation, so every numeric
// field here accepts both and the parsers in normalize.ts coerce.

export type XeroEntity = 'Invoices' | 'BankTransactions' | 'CreditNotes';

export type XeroInvoiceType = 'ACCREC' | 'ACCPAY';

export type XeroCreditNoteType = 'ACCRECCREDIT' | 'ACCPAYCREDIT';

// RECEIVE-TRANSFER and SPEND-TRANSFER are the two halves of one transfer
// between the org's own bank accounts, and GET is the only method that returns
// them (developer.xero.com/.../banktransfers).
export type XeroBankTransactionType =
  | 'RECEIVE'
  | 'RECEIVE-OVERPAYMENT'
  | 'RECEIVE-PREPAYMENT'
  | 'RECEIVE-TRANSFER'
  | 'SPEND'
  | 'SPEND-OVERPAYMENT'
  | 'SPEND-PREPAYMENT'
  | 'SPEND-TRANSFER';

export type XeroTransactionType =
  | XeroInvoiceType
  | XeroCreditNoteType
  | XeroBankTransactionType;

export interface XeroContact {
  ContactID?: string;
  Name?: string;
}

export interface XeroLineItem {
  LineItemID?: string;
  Description?: string;
  LineAmount?: number | string;
  AccountCode?: string;
  AccountId?: string;
}

/**
 * The shape the three fetched entities share. Invoices, credit notes and bank
 * transactions each carry their own id field, so `id` is resolved by api.ts
 * rather than read off one key.
 */
export interface XeroTransaction {
  id: string;
  Type?: XeroTransactionType;
  Status?: string;
  Contact?: XeroContact;
  LineItems?: XeroLineItem[];
  Total?: number | string;
  // "/Date(1401062400000+0000)/" in JSON. DateString is the same instant with
  // no zone, which `new Date` would read as local, so the parser prefers Date.
  Date?: string;
  DateString?: string;
  UpdatedDateUTC?: string;
  Reference?: string;
  InvoiceNumber?: string;
  CreditNoteNumber?: string;
  CurrencyCode?: string;
  // 1 for a base-currency transaction. Xero computes it to convert into the
  // org's base currency, which is the only reason a mixed-currency ledger can
  // be summed at all.
  CurrencyRate?: number | string;
}

// IncomeContra and ExpensesContra reduce their side rather than adding to it.
// financialEffect maps both to a side with sign -1, so a reduction is a
// positive amount under a contra parent rather than a negative amount, which
// charts.ts would abs() away (computationPrimitives.ts).
export type XeroParentCategory =
  | 'Income'
  | 'IncomeContra'
  | 'Expenses'
  | 'ExpensesContra'
  | 'Other';

export interface NormalizedXeroRow {
  sourceType: 'xero';
  sourceId: string;
  date: Date;
  amount: string;
  category: string;
  parentCategory: XeroParentCategory;
  label: string | null;
  counterparty: string | null;
  metadata: {
    xero_id: string;
    entity: XeroEntity;
    txnType: XeroTransactionType | null;
    reference: string | null;
    accountCode: string | null;
    currency: string | null;
  };
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string | null;
  tenantType: string;
}
