import { describe, it, expect } from 'vitest';

import { normalizeTransaction, normalizeTransactions } from './normalize.js';
import type { QbTransaction, QbTransactionType } from './types.js';

function makePurchase(overrides: Partial<QbTransaction> = {}): QbTransaction {
  return {
    Id: 'tx-1',
    TxnDate: '2026-04-10',
    DocNumber: 'P-001',
    VendorRef: { value: '42', name: 'Acme Supplies' },
    Line: [
      {
        Id: 'line-1',
        Amount: 125.5,
        DetailType: 'AccountBasedExpenseLineDetail',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: 'acc-1', name: 'Office Supplies' },
        },
      },
    ],
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<QbTransaction> = {}): QbTransaction {
  return {
    Id: 'tx-2',
    TxnDate: '2026-04-12',
    DocNumber: 'INV-001',
    CustomerRef: { value: '99', name: 'Big Client Co' },
    Line: [
      {
        Id: 'line-1',
        Amount: 2500,
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: 'item-1', name: 'Consulting' },
        },
      },
    ],
    ...overrides,
  };
}

function makePayment(overrides: Partial<QbTransaction> = {}): QbTransaction {
  return {
    Id: 'pay-1',
    TxnDate: '2026-04-13',
    TotalAmt: 2500,
    CustomerRef: { value: '99', name: 'Big Client Co' },
    ...overrides,
  };
}

describe('normalizeTransaction', () => {
  it('maps Purchase to Expenses parentCategory', () => {
    const [row] = normalizeTransaction(makePurchase(), 'Purchase');

    expect(row!.parentCategory).toBe('Expenses');
    expect(row!.sourceType).toBe('quickbooks');
    expect(row!.amount).toBe('125.5');
    expect(row!.category).toBe('Office Supplies');
    expect(row!.label).toBe('Acme Supplies');
  });

  it('maps Invoice to Income parentCategory', () => {
    const [row] = normalizeTransaction(makeInvoice(), 'Invoice');

    expect(row!.parentCategory).toBe('Income');
    expect(row!.category).toBe('Consulting');
    expect(row!.label).toBe('Big Client Co');
  });

  it('maps Bill to Expenses', () => {
    const [row] = normalizeTransaction(makePurchase({ Id: 'tx-bill' }), 'Bill');
    expect(row!.parentCategory).toBe('Expenses');
  });

  it('maps SalesReceipt to Income at its full amount', () => {
    const [row] = normalizeTransaction(makeInvoice({ Id: 'tx-sr' }), 'SalesReceipt');
    expect(row!.parentCategory).toBe('Income');
    // Control for the refund-sign tests below: a sale with no refund in the
    // picture has to keep its full amount, not something a fix quietly shaved.
    expect(row!.amount).toBe('2500');
  });

  it('maps Transfer to Other', () => {
    const tx: QbTransaction = {
      Id: 'tx-transfer',
      TxnDate: '2026-04-10',
      Line: [{ Id: '1', Amount: 500 }],
    };
    const [row] = normalizeTransaction(tx, 'Transfer');
    expect(row!.parentCategory).toBe('Other');
  });

  it('JournalEntry credit line maps to Income', () => {
    const tx: QbTransaction = {
      Id: 'tx-je',
      TxnDate: '2026-04-10',
      Line: [
        {
          Id: 'jl-1',
          Amount: 1000,
          JournalEntryLineDetail: {
            PostingType: 'Credit',
            AccountRef: { value: 'acc-rev', name: 'Revenue' },
          },
        },
      ],
    };
    const [row] = normalizeTransaction(tx, 'JournalEntry');
    expect(row!.parentCategory).toBe('Income');
    expect(row!.category).toBe('Revenue');
  });

  it('JournalEntry debit line maps to Expenses', () => {
    const tx: QbTransaction = {
      Id: 'tx-je2',
      TxnDate: '2026-04-10',
      Line: [
        {
          Id: 'jl-1',
          Amount: 250,
          JournalEntryLineDetail: {
            PostingType: 'Debit',
            AccountRef: { value: 'acc-exp', name: 'Rent Expense' },
          },
        },
      ],
    };
    const [row] = normalizeTransaction(tx, 'JournalEntry');
    expect(row!.parentCategory).toBe('Expenses');
    expect(row!.category).toBe('Rent Expense');
  });

  it('produces one row per line item for multi-line transactions', () => {
    const tx = makePurchase({
      Line: [
        {
          Id: 'l1',
          Amount: 50,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'a1', name: 'Office Supplies' },
          },
        },
        {
          Id: 'l2',
          Amount: 75,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'a2', name: 'Shipping' },
          },
        },
        {
          Id: 'l3',
          Amount: 15,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'a3', name: 'Tax' },
          },
        },
      ],
    });

    const rows = normalizeTransaction(tx, 'Purchase');

    expect(rows).toHaveLength(3);
    expect(rows[0]!.sourceId).toBe('tx-1-l1');
    expect(rows[1]!.sourceId).toBe('tx-1-l2');
    expect(rows[2]!.sourceId).toBe('tx-1-l3');
    expect(rows[0]!.category).toBe('Office Supplies');
    expect(rows[1]!.category).toBe('Shipping');
    expect(rows[2]!.category).toBe('Tax');
  });

  // Prefixed, not a bare index. QuickBooks numbers its line Ids from 1 and this
  // index counts from 0, so a bare index lands on the previous line's Id.
  it('falls back to a prefixed index when line Id is missing', () => {
    const tx = makePurchase({
      Line: [
        {
          Amount: 50,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'a1', name: 'Office Supplies' },
          },
        },
      ],
    });

    const rows = normalizeTransaction(tx, 'Purchase');
    expect(rows[0]!.sourceId).toBe('tx-1-i0');
  });

  it('normalizes amount to positive (abs value)', () => {
    const tx = makePurchase({
      Line: [
        {
          Id: 'l1',
          Amount: -250.75,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: 'a', name: 'Refund' },
          },
        },
      ],
    });

    const [row] = normalizeTransaction(tx, 'CreditMemo');
    expect(row!.amount).toBe('250.75');
  });

  it('prefers EntityRef name over PrivateNote and DocNumber', () => {
    const tx = makePurchase({
      VendorRef: { value: '1', name: 'Vendor Name' },
      PrivateNote: 'some note',
      DocNumber: 'DOC-123',
    });
    const [row] = normalizeTransaction(tx, 'Purchase');
    expect(row!.label).toBe('Vendor Name');
  });

  it('falls back from EntityRef to PrivateNote', () => {
    const tx = makePurchase({
      VendorRef: undefined,
      PrivateNote: 'office run',
      DocNumber: 'DOC-123',
    });
    const [row] = normalizeTransaction(tx, 'Purchase');
    expect(row!.label).toBe('office run');
  });

  it('falls back to DocNumber when no entity or memo', () => {
    const tx = makePurchase({
      VendorRef: undefined,
      PrivateNote: undefined,
      DocNumber: 'DOC-123',
    });
    const [row] = normalizeTransaction(tx, 'Purchase');
    expect(row!.label).toBe('DOC-123');
  });

  it('returns null label when nothing is available', () => {
    const tx = makePurchase({
      VendorRef: undefined,
      CustomerRef: undefined,
      EntityRef: undefined,
      PrivateNote: undefined,
      DocNumber: undefined,
    });
    const [row] = normalizeTransaction(tx, 'Purchase');
    expect(row!.label).toBeNull();
  });

  it('falls back to Uncategorized when no account ref', () => {
    const tx: QbTransaction = {
      Id: 'tx-no-acc',
      TxnDate: '2026-04-10',
      Line: [{ Id: 'l1', Amount: 100 }],
    };
    const [row] = normalizeTransaction(tx, 'Purchase');
    expect(row!.category).toBe('Uncategorized');
  });

  it('includes qb_id and txnType in metadata', () => {
    const [row] = normalizeTransaction(makePurchase(), 'Purchase');

    expect(row!.metadata.qb_id).toBe('tx-1');
    expect(row!.metadata.txnType).toBe('Purchase');
    expect(row!.metadata.docNumber).toBe('P-001');
    expect(row!.metadata.accountCode).toBe('acc-1');
  });

  it('handles transaction with no line items via synthetic row', () => {
    const tx: QbTransaction = {
      Id: 'tx-payment',
      TxnDate: '2026-04-10',
      TotalAmt: 500,
      CustomerRef: { value: '1', name: 'Customer' },
    };

    const rows = normalizeTransaction(tx, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceId).toBe('tx-payment-0');
    expect(rows[0]!.amount).toBe('500');
    expect(rows[0]!.category).toBe('Uncategorized');
    expect(rows[0]!.parentCategory).toBe('Income');
  });
});

describe('normalizeTransactions', () => {
  it('flattens multiple transactions into combined array', () => {
    const transactions = [makePurchase(), makePurchase({ Id: 'tx-2' })];
    const rows = normalizeTransactions(transactions, 'Purchase');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.metadata.qb_id).toBe('tx-1');
    expect(rows[1]!.metadata.qb_id).toBe('tx-2');
  });

  it('expands multi-line transactions when flattening', () => {
    const multiLine = makePurchase({
      Line: [
        {
          Id: 'a',
          Amount: 10,
          AccountBasedExpenseLineDetail: { AccountRef: { value: '1', name: 'A' } },
        },
        {
          Id: 'b',
          Amount: 20,
          AccountBasedExpenseLineDetail: { AccountRef: { value: '2', name: 'B' } },
        },
      ],
    });
    const rows = normalizeTransactions([multiLine], 'Purchase');
    expect(rows).toHaveLength(2);
  });
});

// DW-233: CreditMemo and RefundReceipt were both in INCOME_TYPES, so a refund
// added to reported revenue instead of subtracting from it, overstating net
// income by twice the refund amount. Mirrors the fix square/normalize.ts
// already shipped for Square refunds, rather than inventing a second rule.
describe('refund sign', () => {
  const soldLine = {
    Id: 'line-1',
    Amount: 1000,
    DetailType: 'SalesItemLineDetail',
    SalesItemLineDetail: { ItemRef: { value: 'item-1', name: 'Consulting' } },
  };

  function makeRefund(overrides: Partial<QbTransaction> = {}): QbTransaction {
    return {
      Id: 'ref-1',
      TxnDate: '2026-04-15',
      DocNumber: 'REF-001',
      CustomerRef: { value: '99', name: 'Big Client Co' },
      Line: [
        {
          Id: 'line-1',
          Amount: 300,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: 'item-1', name: 'Consulting' } },
        },
      ],
      ...overrides,
    };
  }

  it('nets an Invoice and a RefundReceipt against it to the true amount', () => {
    const rows = [
      ...normalizeTransaction(makeInvoice({ Id: 'inv-1', Line: [soldLine] }), 'Invoice'),
      ...normalizeTransaction(makeRefund(), 'RefundReceipt'),
    ];

    const income = rows
      .filter((r) => r.parentCategory === 'Income')
      .reduce((sum, r) => sum + Number(r.amount), 0);
    const expenseRows = rows.filter((r) => r.parentCategory === 'Expenses');

    expect(income).toBe(1000);
    expect(expenseRows).toHaveLength(1);
    expect(expenseRows[0]!.category).toBe('Refunds');
    expect(expenseRows[0]!.amount).toBe('300');
  });

  it('nets an Invoice and a CreditMemo against it the same way', () => {
    const rows = [
      ...normalizeTransaction(makeInvoice({ Id: 'inv-2', Line: [soldLine] }), 'Invoice'),
      ...normalizeTransaction(makeRefund({ Id: 'cm-1' }), 'CreditMemo'),
    ];

    const income = rows
      .filter((r) => r.parentCategory === 'Income')
      .reduce((sum, r) => sum + Number(r.amount), 0);
    const expenseRows = rows.filter((r) => r.parentCategory === 'Expenses');

    expect(income).toBe(1000);
    expect(expenseRows).toHaveLength(1);
    expect(expenseRows[0]!.category).toBe('Refunds');
    expect(expenseRows[0]!.amount).toBe('300');
  });

  // VendorCredit stays in Expenses under its own account category. Moving it
  // to Income, the mirror of the fix above, would count a vendor return as
  // revenue and corrupt the revenue-specific stats keyed on parentCategory
  // === 'Income' (see the comment beside it in normalize.ts). The category
  // assertion guards a quieter version of the same mistake: routing
  // VendorCredit into REFUND_TYPES instead of EXPENSE_TYPES leaves
  // parentCategory at 'Expenses', so a parentCategory-only check would still
  // pass, while silently relabeling every vendor credit 'Refunds' and
  // merging it into the customer-refund line.
  it('leaves VendorCredit in Expenses under its own category, not folded into Refunds', () => {
    const [row] = normalizeTransaction(makePurchase({ Id: 'vc-1' }), 'VendorCredit');
    expect(row!.parentCategory).toBe('Expenses');
    expect(row!.category).toBe('Office Supplies');
  });
});

// Sandbox invoice 130, the shape that broke the first real sync. Three item
// lines and a SubTotal line repeating their sum. Importing the subtotal doubles
// the invoice, and because the subtotal carries no Id it also took the previous
// line's number and made the batched upsert fail on a duplicate key.
describe('aggregate lines', () => {
  function invoiceWithSubtotal() {
    return makeInvoice({
      Id: '130',
      TotalAmt: 335.25,
      Line: [
        {
          Id: '1',
          Amount: 275,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '5', name: 'Rock Fountain' } },
        },
        {
          Id: '2',
          Amount: 12.75,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '11', name: 'Pump' } },
        },
        {
          Id: '3',
          Amount: 47.5,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '3', name: 'Concrete' } },
        },
        { Amount: 335.25, DetailType: 'SubTotalLineDetail' },
      ],
    });
  }

  it('drops the SubTotal line so the invoice is not counted twice', () => {
    const rows = normalizeTransaction(invoiceWithSubtotal(), 'Invoice');

    expect(rows).toHaveLength(3);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    expect(total).toBeCloseTo(335.25, 2);
    expect(rows.map((r) => r.category)).toEqual(['Rock Fountain', 'Pump', 'Concrete']);
  });

  it('leaves no duplicate sourceId for the batched upsert to choke on', () => {
    const rows = normalizeTransaction(invoiceWithSubtotal(), 'Invoice');
    const ids = rows.map((r) => r.sourceId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['130-1', '130-2', '130-3']);
  });

  it('drops a DescriptionOnly line, which carries text rather than money', () => {
    const tx = makeInvoice({
      Line: [
        {
          Id: '1',
          Amount: 100,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '6', name: 'Gardening' } },
        },
        { Id: '2', Amount: 0, DetailType: 'DescriptionOnly' },
      ],
    });

    const rows = normalizeTransaction(tx, 'Invoice');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe('Gardening');
  });

  it('keeps a line with no DetailType rather than silently dropping money', () => {
    const tx = makeInvoice({
      Line: [
        {
          Id: '1',
          Amount: 42,
          SalesItemLineDetail: { ItemRef: { value: '6', name: 'Gardening' } },
        },
      ],
    });

    const rows = normalizeTransaction(tx, 'Invoice');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('42');
  });

  it('falls back to TotalAmt when every line was an aggregate', () => {
    const tx = makeInvoice({
      Id: '42',
      TotalAmt: 75,
      Line: [{ Amount: 75, DetailType: 'SubTotalLineDetail' }],
    });

    const rows = normalizeTransaction(tx, 'Invoice');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('75');
    expect(rows[0]!.sourceId).toBe('42-0');
    expect(rows[0]!.category).toBe('Uncategorized');
  });
});

// DW-231: a Payment settling an Invoice (or a Deposit batching a Payment) was
// recorded as Income twice, once from the invoice and once from the thing
// that paid it. The $2,500 shape below is the confirmed reproduction.
describe('LinkedTxn settlement, DW-231', () => {
  function income(rows: ReturnType<typeof normalizeTransaction>): number {
    return rows.reduce((sum, r) => sum + Number(r.amount), 0);
  }

  it('a fully-applied payment with lines adds nothing, the invoice is the sale', () => {
    const invoice = makeInvoice();
    const payment = makePayment({
      Line: [
        {
          Id: '1',
          Amount: 2500,
          DetailType: 'PaymentLineDetail',
          LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
        },
      ],
    });

    const rows = [
      ...normalizeTransaction(invoice, 'Invoice'),
      ...normalizeTransaction(payment, 'Payment'),
    ];

    expect(income(rows)).toBe(2500);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.txnType).toBe('Invoice');
  });

  it('a fully-applied payment with no lines still adds nothing', () => {
    const invoice = makeInvoice();
    // No Line array at all, the shape that hits the TotalAmt branch. LinkedTxn
    // has to live on the transaction itself for this one, there is no line to
    // put it on.
    const payment = makePayment({
      LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
    });

    const rows = [
      ...normalizeTransaction(invoice, 'Invoice'),
      ...normalizeTransaction(payment, 'Payment'),
    ];

    expect(income(rows)).toBe(2500);
    expect(rows).toHaveLength(1);
  });

  it('a partial payment with no UnappliedAmt falls back to the LinkedTxn rule and adds nothing', () => {
    // UnappliedAmt deliberately absent: an older payload or a trimmed webhook
    // body might not carry it, and this is what the normalizer does without
    // it. See the next test for the same $1,000/$400 shape with the field
    // present, where the answer changes.
    const invoice = makeInvoice({
      Id: 'inv-partial',
      TotalAmt: 1000,
      Line: [
        {
          Id: '1',
          Amount: 1000,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '1', name: 'Consulting' } },
        },
      ],
    });
    const partialPayment = makePayment({
      Id: 'pay-partial',
      TotalAmt: 400,
      Line: [
        {
          Id: '1',
          Amount: 400,
          DetailType: 'PaymentLineDetail',
          LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
        },
      ],
    });

    const rows = [
      ...normalizeTransaction(invoice, 'Invoice'),
      ...normalizeTransaction(partialPayment, 'Payment'),
    ];

    expect(income(rows)).toBe(1000);
  });

  it('a partially applied payment contributes its UnappliedAmt, not zero', () => {
    // Same $1,000 invoice, same $400 applied, but this payment also reports
    // UnappliedAmt. The LinkedTxn-only rule above would call this fully
    // settled and add nothing; UnappliedAmt knows $600 of it was not applied
    // to anything and is real, uncounted money.
    const invoice = makeInvoice({
      Id: 'inv-partial-2',
      TotalAmt: 1000,
      Line: [
        {
          Id: '1',
          Amount: 1000,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '1', name: 'Consulting' } },
        },
      ],
    });
    const partialPayment = makePayment({
      Id: 'pay-partial-2',
      TotalAmt: 1000,
      UnappliedAmt: 600,
      Line: [
        {
          Id: '1',
          Amount: 400,
          DetailType: 'PaymentLineDetail',
          LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
        },
      ],
    });

    const rows = [
      ...normalizeTransaction(invoice, 'Invoice'),
      ...normalizeTransaction(partialPayment, 'Payment'),
    ];

    expect(income(rows)).toBe(1600);
  });

  it('a fully-applied payment with UnappliedAmt of 0 adds nothing', () => {
    const invoice = makeInvoice({
      Id: 'inv-full',
      TotalAmt: 1000,
      Line: [
        {
          Id: '1',
          Amount: 1000,
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { ItemRef: { value: '1', name: 'Consulting' } },
        },
      ],
    });
    const fullyAppliedPayment = makePayment({
      Id: 'pay-full',
      TotalAmt: 1000,
      UnappliedAmt: 0,
      Line: [
        {
          Id: '1',
          Amount: 1000,
          DetailType: 'PaymentLineDetail',
          LinkedTxn: [{ TxnId: invoice.Id, TxnType: 'Invoice' }],
        },
      ],
    });

    const rows = [
      ...normalizeTransaction(invoice, 'Invoice'),
      ...normalizeTransaction(fullyAppliedPayment, 'Payment'),
    ];

    expect(income(rows)).toBe(1000);
  });

  it('a payment with no LinkedTxn stays Income, real money with no invoice behind it', () => {
    const unapplied = makePayment({ Id: 'pay-unapplied', TotalAmt: 500 });

    const rows = normalizeTransaction(unapplied, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('500');
    expect(rows[0]!.parentCategory).toBe('Income');
  });

  it('a fully unapplied payment with UnappliedAmt set stays Income at the full amount', () => {
    // UnappliedAmt equal to TotalAmt is what a real prepayment looks like:
    // nothing to net out, the whole thing is still uncounted.
    const unapplied = makePayment({ Id: 'pay-unapplied-2', TotalAmt: 500, UnappliedAmt: 500 });

    const rows = normalizeTransaction(unapplied, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('500');
    expect(rows[0]!.parentCategory).toBe('Income');
  });

  it('a SalesReceipt alone is still counted exactly once', () => {
    const receipt = makeInvoice({ Id: 'sr-1' });

    const rows = normalizeTransaction(receipt, 'SalesReceipt');

    expect(income(rows)).toBe(2500);
  });

  it('a deposit linked to a payment adds nothing, the payment already recorded it', () => {
    const unappliedPayment = makePayment({ Id: 'pay-to-deposit', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-1',
      TxnDate: '2026-04-14',
      TotalAmt: 500,
      Line: [
        {
          Id: '1',
          Amount: 500,
          LinkedTxn: [{ TxnId: unappliedPayment.Id, TxnType: 'Payment' }],
        },
      ],
    };

    const rows = [
      ...normalizeTransaction(unappliedPayment, 'Payment'),
      ...normalizeTransaction(deposit, 'Deposit'),
    ];

    expect(income(rows)).toBe(500);
  });

  it('a deposit linked to a SalesReceipt adds nothing, the receipt already recorded it', () => {
    // Deposit's rule checks INCOME_TYPES generally, not Payment specifically,
    // so a SalesReceipt batched into a bank deposit closes the same way.
    const receipt = makeInvoice({ Id: 'sr-dep-1' });
    const deposit: QbTransaction = {
      Id: 'dep-sr-1',
      TxnDate: '2026-04-14',
      TotalAmt: 2500,
      Line: [
        {
          Id: '1',
          Amount: 2500,
          LinkedTxn: [{ TxnId: receipt.Id, TxnType: 'SalesReceipt' }],
        },
      ],
    };

    const rows = [
      ...normalizeTransaction(receipt, 'SalesReceipt'),
      ...normalizeTransaction(deposit, 'Deposit'),
    ];

    expect(income(rows)).toBe(2500);
  });

  it('a deposit with no LinkedTxn stays Income, e.g. a loan deposit', () => {
    const loanDeposit: QbTransaction = {
      Id: 'dep-2',
      TxnDate: '2026-04-14',
      TotalAmt: 5000,
      Line: [
        {
          Id: '1',
          Amount: 5000,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: { value: '1', name: 'Owner Loan' } },
        },
      ],
    };

    const rows = normalizeTransaction(loanDeposit, 'Deposit');

    expect(income(rows)).toBe(5000);
    expect(rows[0]!.category).toBe('Owner Loan');
  });

  // The deposit form has two sections, "Select the payments" (LinkedTxn,
  // already recorded) and "Add funds to this deposit" (new money), and a
  // real deposit routinely has both. The three tests above are each pure
  // one or the other, which is why suppressing the whole transaction on
  // "any line links" passed every one of them while still losing the
  // add-funds money.
  it('a mixed deposit drops the linked line and keeps the add-funds line', () => {
    const sweptPayment = makePayment({ Id: 'pay-swept', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-mixed',
      TxnDate: '2026-04-14',
      TotalAmt: 5500,
      Line: [
        {
          Id: '1',
          Amount: 500,
          LinkedTxn: [{ TxnId: sweptPayment.Id, TxnType: 'Payment' }],
        },
        {
          Id: '2',
          Amount: 5000,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: { value: '2', name: 'Owner Loan' } },
        },
      ],
    };

    const rows = normalizeTransaction(deposit, 'Deposit');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('5000');
    expect(rows[0]!.category).toBe('Owner Loan');
    expect(rows[0]!.sourceId).toBe('dep-mixed-2');
  });

  // A root link cannot suppress a deposit that still has an unlinked line:
  // that line is new money by definition, and nothing else recorded it.
  // An earlier version of this fix checked the root up front, before the
  // per-line filter ran, and suppressed this shape entirely; it took this
  // same $5,000 Owner Loan line from a real row to nothing, a regression
  // only caught because a later review measured it against the pre-rework
  // baseline. The root check only matters once no real line is left, see
  // the two tests below this one.
  it('a root-linked deposit still reports an unlinked line, the root alone cannot suppress it', () => {
    const unappliedPayment = makePayment({ Id: 'pay-root-linked', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-root-linked',
      TxnDate: '2026-04-14',
      TotalAmt: 500,
      LinkedTxn: [{ TxnId: unappliedPayment.Id, TxnType: 'Payment' }],
      Line: [
        {
          Id: '1',
          Amount: 500,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: { value: '1', name: 'Owner Loan' } },
        },
      ],
    };

    const rows = normalizeTransaction(deposit, 'Deposit');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('500');
    expect(rows[0]!.parentCategory).toBe('Income');
    expect(rows[0]!.category).toBe('Owner Loan');
  });

  it('a root-linked deposit mixing a linked line with an unlinked one still reports the unlinked line', () => {
    // The same regression from the other direction: a deposit that is both
    // root-linked and has a per-line linked/unlinked mix. The per-line
    // filter already drops the linked line; the root link must not also
    // wipe out the unlinked one.
    const sweptPayment = makePayment({ Id: 'pay-swept-root', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-root-mixed',
      TxnDate: '2026-04-14',
      TotalAmt: 5500,
      LinkedTxn: [{ TxnId: sweptPayment.Id, TxnType: 'Payment' }],
      Line: [
        {
          Id: '1',
          Amount: 500,
          LinkedTxn: [{ TxnId: sweptPayment.Id, TxnType: 'Payment' }],
        },
        {
          Id: '2',
          Amount: 5000,
          DetailType: 'DepositLineDetail',
          DepositLineDetail: { AccountRef: { value: '2', name: 'Owner Loan' } },
        },
      ],
    };

    const rows = normalizeTransaction(deposit, 'Deposit');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('5000');
    expect(rows[0]!.category).toBe('Owner Loan');
  });

  it('a root-linked deposit with no lines at all still suppresses', () => {
    const unappliedPayment = makePayment({ Id: 'pay-root-linked-2', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-root-linked-2',
      TxnDate: '2026-04-14',
      TotalAmt: 500,
      LinkedTxn: [{ TxnId: unappliedPayment.Id, TxnType: 'Payment' }],
    };

    expect(normalizeTransaction(deposit, 'Deposit')).toEqual([]);
  });

  it('a root-linked deposit with nothing but an aggregate line still suppresses', () => {
    // The second shape that reaches the TotalAmt fallback: a real Line
    // array that carries no reportable amount once SubTotal/DescriptionOnly
    // lines are dropped, same as the lineless case just above.
    const unappliedPayment = makePayment({ Id: 'pay-root-linked-3', TotalAmt: 500 });
    const deposit: QbTransaction = {
      Id: 'dep-root-linked-3',
      TxnDate: '2026-04-14',
      TotalAmt: 500,
      LinkedTxn: [{ TxnId: unappliedPayment.Id, TxnType: 'Payment' }],
      Line: [{ Amount: 500, DetailType: 'SubTotalLineDetail' }],
    };

    expect(normalizeTransaction(deposit, 'Deposit')).toEqual([]);
  });
});

// DW-233 follow-up: UnappliedAmt ran before any look at links, so a payment
// reporting 0 with nothing to corroborate it, no LinkedTxn at all, or one
// linked only to an expense, returned zero rows instead of its own TotalAmt.
describe('UnappliedAmt needs a link to income to suppress, DW-233 follow-up', () => {
  it('UnappliedAmt of 0 with no LinkedTxn at all falls back to TotalAmt as Income', () => {
    const payment = makePayment({ Id: 'pay-zero-unlinked', TotalAmt: 1000, UnappliedAmt: 0 });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('1000');
    expect(rows[0]!.parentCategory).toBe('Income');
  });

  it('UnappliedAmt of 0 linked only to a Bill falls back to TotalAmt instead of vanishing', () => {
    // A Bill is EXPENSE_TYPES, not INCOME_TYPES, so it settles nothing this
    // payment's own revenue is already counted by. Reproduces the bug found
    // by execution: this used to return zero rows, cash vanishing on an
    // expense link.
    const payment = makePayment({
      Id: 'pay-zero-bill',
      TotalAmt: 1000,
      UnappliedAmt: 0,
      LinkedTxn: [{ TxnId: 'bill-1', TxnType: 'Bill' }],
    });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('1000');
    expect(rows[0]!.parentCategory).toBe('Income');
  });
});

describe('UnappliedAmt numeric guards, DW-233 follow-up', () => {
  it('a stringified UnappliedAmt is coerced rather than falling back to the link rule', () => {
    // api.ts:113 casts the QuickBooks response with no runtime validation,
    // so a payload where UnappliedAmt arrives as text is not hypothetical.
    // Number.isFinite alone does not coerce, so this used to silently
    // revert to suppression and drop the $600 remainder.
    const payment = makePayment({
      Id: 'pay-string-unapplied',
      TotalAmt: 1000,
      UnappliedAmt: '600' as unknown as number,
    });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('600');
  });

  it('an UnappliedAmt bigger than TotalAmt is unusable, not a bigger Income row', () => {
    const payment = makePayment({ Id: 'pay-over-unapplied', TotalAmt: 1000, UnappliedAmt: 1500 });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('1000');
  });

  it('a negative UnappliedAmt is unusable, not a positive Income row via Math.abs', () => {
    const payment = makePayment({
      Id: 'pay-negative-unapplied',
      TotalAmt: 1000,
      UnappliedAmt: -600,
    });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('1000');
  });

  // A missing TotalAmt used to turn a perfectly good UnappliedAmt into an
  // unusable one: unapplied <= NaN is always false, so the range check
  // failed even though there was nothing to be out of range of. api.ts's
  // unvalidated cast can drop TotalAmt exactly as easily as UnappliedAmt,
  // so its absence is not evidence the other field is wrong.
  it('a sane UnappliedAmt with no TotalAmt still produces its row, unlinked', () => {
    const payment = makePayment({ Id: 'pay-no-total', TotalAmt: undefined, UnappliedAmt: 600 });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('600');
  });

  it('a sane UnappliedAmt with no TotalAmt still produces its row even when linked', () => {
    // Previously this returned zero rows: isSane went false on the missing
    // TotalAmt, which fell through to isAlreadyRecorded, which saw the
    // link and suppressed. The $600 vanished with no trace.
    const payment = makePayment({
      Id: 'pay-no-total-linked',
      TotalAmt: undefined,
      UnappliedAmt: 600,
      LinkedTxn: [{ TxnId: 'inv-1', TxnType: 'Invoice' }],
    });

    const rows = normalizeTransaction(payment, 'Payment');

    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe('600');
  });
});

// I6: the review said treating a CreditMemo or RefundReceipt link as
// "already counted" was wrong on both sign and direction, and asked for the
// suppression set to narrow. Moving both into REFUND_TYPES (8e7e6be)
// narrowed linksToIncomeType on its own; this pins the resulting set so a
// future change to either Set has to look at this test, not just discover
// the gap by execution the way the review did with Bill.
describe('which LinkedTxn types suppress a payment, I6', () => {
  const suppresses: QbTransactionType[] = ['Invoice', 'SalesReceipt', 'Deposit'];
  const doesNotSuppress: QbTransactionType[] = ['CreditMemo', 'RefundReceipt', 'Bill'];

  for (const txnType of suppresses) {
    it(`a ${txnType} link suppresses the payment`, () => {
      const payment = makePayment({
        Id: `pay-link-${txnType}`,
        TotalAmt: 500,
        LinkedTxn: [{ TxnId: 'linked-1', TxnType: txnType }],
      });

      expect(normalizeTransaction(payment, 'Payment')).toEqual([]);
    });
  }

  for (const txnType of doesNotSuppress) {
    it(`a ${txnType} link does not suppress the payment`, () => {
      const payment = makePayment({
        Id: `pay-link-${txnType}`,
        TotalAmt: 500,
        LinkedTxn: [{ TxnId: 'linked-1', TxnType: txnType }],
      });

      const rows = normalizeTransaction(payment, 'Payment');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.parentCategory).toBe('Income');
    });
  }
});
