import { describe, it, expect } from 'vitest';

import { normalizeTransaction, normalizeTransactions } from './normalize.js';
import type { QbTransaction } from './types.js';

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
    const [row] = normalizeTransaction(
      makePurchase({ Id: 'tx-bill' }),
      'Bill',
    );
    expect(row!.parentCategory).toBe('Expenses');
  });

  it('maps SalesReceipt to Income', () => {
    const [row] = normalizeTransaction(makeInvoice({ Id: 'tx-sr' }), 'SalesReceipt');
    expect(row!.parentCategory).toBe('Income');
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

  it('uses line index when line Id is missing', () => {
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
    expect(rows[0]!.sourceId).toBe('tx-1-0');
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
        { Id: 'a', Amount: 10, AccountBasedExpenseLineDetail: { AccountRef: { value: '1', name: 'A' } } },
        { Id: 'b', Amount: 20, AccountBasedExpenseLineDetail: { AccountRef: { value: '2', name: 'B' } } },
      ],
    });
    const rows = normalizeTransactions([multiLine], 'Purchase');
    expect(rows).toHaveLength(2);
  });
});
