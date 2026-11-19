import type {
  NormalizedXeroRow,
  XeroEntity,
  XeroLineItem,
  XeroParentCategory,
  XeroTransaction,
  XeroTransactionType,
} from './types.js';

/**
 * Statuses that represent money. Everything else is deliberately dropped:
 * DRAFT and SUBMITTED have not been approved, VOIDED and DELETED were
 * cancelled. This is Xero's version of the Estimate problem the QuickBooks
 * normalizer has, and a worse one, because a voided invoice keeps its full
 * `Total` and would read as revenue that was explicitly taken back.
 */
const COUNTABLE_STATUSES: Record<XeroEntity, ReadonlySet<string>> = {
  Invoices: new Set(['AUTHORISED', 'PAID']),
  CreditNotes: new Set(['AUTHORISED', 'PAID']),
  BankTransactions: new Set(['AUTHORISED']),
};

/**
 * Which side of the ledger each transaction type lands on.
 *
 * A Record rather than a switch, the same reason `SEES_OPERATING_COST` is one:
 * a type Xero adds should fail to compile rather than default into income or
 * expenses.
 *
 * The entries that look like omissions and are not:
 *
 *   - `*-TRANSFER` is one movement between two of the org's own bank accounts,
 *     returned as two rows. Counting them would add the same money to revenue
 *     *and* to expenses, inflating both and leaving profit unchanged, which is
 *     the hardest version of this bug to notice. Plaid's normalizer drops its
 *     TRANSFER_IN/TRANSFER_OUT pair for the same reason.
 *   - `*-PREPAYMENT` and `*-OVERPAYMENT` are cash that has arrived without an
 *     invoice behind it yet. Recording it as income now and again when the
 *     invoice lands double-counts it.
 *   - `ACCRECCREDIT` is a credit note to a customer, so it is a refund rather
 *     than negative revenue: a positive Expenses row categorized 'Refunds',
 *     matching what the QuickBooks and Shopify normalizers do with theirs so
 *     the sign means one thing whichever connector wrote the row.
 *   - `ACCPAYCREDIT` is a vendor crediting the business, which reduces what is
 *     owed, so it is the expense side without being an expense (DW-235).
 */
const SIDE_BY_TYPE: Record<XeroTransactionType, XeroParentCategory> = {
  ACCREC: 'Income',
  ACCPAY: 'Expenses',
  ACCRECCREDIT: 'Expenses',
  ACCPAYCREDIT: 'ExpensesContra',
  RECEIVE: 'Income',
  SPEND: 'Expenses',
  'RECEIVE-TRANSFER': 'Other',
  'SPEND-TRANSFER': 'Other',
  'RECEIVE-PREPAYMENT': 'Other',
  'SPEND-PREPAYMENT': 'Other',
  'RECEIVE-OVERPAYMENT': 'Other',
  'SPEND-OVERPAYMENT': 'Other',
};

const REFUND_TYPES = new Set<XeroTransactionType>(['ACCRECCREDIT']);

// A negative line on a positive transaction, which in practice is a discount.
// Abs()ing it would report an invoice of 100 less 20 as 120, and dropping it
// would report 100; neither is 80. Writing the magnitude against a contra
// parent category is what gets 80, because financialEffect maps *Contra to the
// same side with sign -1 and every consumer multiplies by that sign.
//
// Deliberately not a negative amount: charts.ts abs()es amounts, so the
// direction has to live in the parent category or the stat path and the chart
// path disagree about the same row. `IncomeContra` has been in CONTRA_SIDE
// since it was written; this is its first writer.
const CONTRA_OF: Partial<Record<XeroParentCategory, XeroParentCategory>> = {
  Income: 'IncomeContra',
  Expenses: 'ExpensesContra',
};

const DOTNET_DATE = /\/Date\((-?\d+)/;

/**
 * Xero sends `/Date(1401062400000+0000)/` in JSON and a `DateString` alongside
 * it. The epoch form is unambiguous, so it wins; `DateString` carries no zone
 * and `new Date` would read it as the server's local time, shifting a
 * transaction across a month boundary for anyone west of UTC.
 */
export function parseXeroDate(value: string | undefined, fallback?: string): Date | null {
  const match = value?.match(DOTNET_DATE);
  if (match) {
    const date = new Date(Number(match[1]));
    if (!Number.isNaN(date.getTime())) return date;
  }

  for (const candidate of [value, fallback]) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function parseXeroNumber(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Xero computes this to convert a transaction into the organisation's base
// currency, and reports 1 when there is nothing to convert. Applying it is what
// lets a mixed-currency ledger be summed at all, and it uses Xero's own rate
// rather than one this product would have to source.
function baseCurrencyFactor(tx: XeroTransaction): number {
  const rate = parseXeroNumber(tx.CurrencyRate);
  if (rate === null || rate <= 0) return 1;
  return rate;
}

function counterpartyOf(tx: XeroTransaction): string | null {
  const name = tx.Contact?.Name?.trim();
  return name && name.length > 0 ? name : null;
}

// Reference first because it is the field an owner actually typed. Falls back
// to the document number, then the contact. Separate from counterparty on
// purpose: label mixes sources and cannot be grouped on, which is the whole
// reason counterparty is its own column (DW-280).
function labelOf(tx: XeroTransaction): string | null {
  return (
    tx.Reference?.trim() ||
    tx.InvoiceNumber?.trim() ||
    tx.CreditNoteNumber?.trim() ||
    counterpartyOf(tx) ||
    null
  );
}

function referenceOf(tx: XeroTransaction): string | null {
  return tx.Reference ?? tx.InvoiceNumber ?? tx.CreditNoteNumber ?? null;
}

function categoryOf(
  tx: XeroTransaction,
  line: XeroLineItem | null,
  accountNames: Map<string, string>,
): string {
  if (tx.Type && REFUND_TYPES.has(tx.Type)) return 'Refunds';
  const code = line?.AccountCode;
  if (!code) return 'Uncategorized';
  // Falls back to the bare code rather than 'Uncategorized' when the accounts
  // lookup came back empty: "445" is poor but it is still the real account, and
  // collapsing every category into one bucket loses the breakdown entirely.
  return accountNames.get(code) ?? code;
}

export function normalizeTransaction(
  tx: XeroTransaction,
  entity: XeroEntity,
  accountNames: Map<string, string>,
): NormalizedXeroRow[] {
  if (!COUNTABLE_STATUSES[entity].has(tx.Status ?? '')) return [];

  const side = tx.Type ? SIDE_BY_TYPE[tx.Type] : undefined;
  // An unmapped type is new rather than classifiable, and 'Other' keeps the row
  // without putting it on a side it may not belong to.
  const parentSide: XeroParentCategory = side ?? 'Other';

  const date = parseXeroDate(tx.Date, tx.DateString);
  // Without a date the row cannot be bucketed into a month, which is what every
  // stat groups by, so it would sit in the table contributing to nothing.
  if (!date) return [];

  const factor = baseCurrencyFactor(tx);
  const label = labelOf(tx);
  const counterparty = counterpartyOf(tx);
  const reference = referenceOf(tx);
  const currency = tx.CurrencyCode ?? null;

  const rowFor = (
    line: XeroLineItem | null,
    rawAmount: number,
    lineKey: string,
  ): NormalizedXeroRow | null => {
    const converted = rawAmount * factor;
    if (converted === 0) return null;

    // A negative line against a real side becomes a contra row on that same
    // side. 'Other' has no contra form, and nothing reads its sign anyway.
    const isReduction = converted < 0;
    const parentCategory =
      isReduction && CONTRA_OF[parentSide] ? CONTRA_OF[parentSide]! : parentSide;

    return {
      sourceType: 'xero',
      sourceId: `${entity}-${tx.id}-${lineKey}`,
      date,
      amount: String(Math.abs(converted)),
      category: categoryOf(tx, line, accountNames),
      parentCategory,
      label,
      counterparty,
      metadata: {
        xero_id: tx.id,
        entity,
        txnType: tx.Type ?? null,
        reference,
        accountCode: line?.AccountCode ?? null,
        currency,
      },
    };
  };

  const lines = (tx.LineItems ?? []).filter((line) => parseXeroNumber(line.LineAmount) !== null);

  if (lines.length === 0) {
    const total = parseXeroNumber(tx.Total);
    if (total === null) return [];
    // No line items, which happens when a payload predates the paging fix in
    // api.ts or Xero simply has none. One row off the total keeps the money,
    // uncategorized.
    const row = rowFor(null, total, '0');
    return row ? [row] : [];
  }

  return lines
    .map((line, index) =>
      rowFor(line, parseXeroNumber(line.LineAmount)!, line.LineItemID ?? `i${index}`),
    )
    .filter((row): row is NormalizedXeroRow => row !== null);
}

export function normalizeTransactions(
  transactions: XeroTransaction[],
  entity: XeroEntity,
  accountNames: Map<string, string>,
): NormalizedXeroRow[] {
  return transactions.flatMap((tx) => normalizeTransaction(tx, entity, accountNames));
}
