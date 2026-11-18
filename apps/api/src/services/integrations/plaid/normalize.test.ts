import { describe, expect, it } from 'vitest';

import { normalizePlaidTransactions } from './normalize.js';
import type { PlaidTransaction } from './types.js';

function txn(over: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: 'tx-1',
    account_id: 'acct-1',
    amount: 42.5,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: '2026-11-04',
    authorized_date: null,
    name: 'SQ *BLUE BOTTLE 4411',
    merchant_name: 'Blue Bottle Coffee',
    pending: false,
    pending_transaction_id: null,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    ...over,
  };
}

describe('normalizePlaidTransactions', () => {
  // Plaid's sign convention is backwards from how the number reads, and getting
  // it wrong is silent: every expense would land as revenue.
  it('reads a positive amount as money leaving the account', () => {
    const [row] = normalizePlaidTransactions([txn({ amount: 42.5 })]);

    expect(row).toMatchObject({ parentCategory: 'Expenses', amount: '42.50' });
  });

  it('reads a negative amount as money arriving', () => {
    const [row] = normalizePlaidTransactions([
      txn({ amount: -1200, personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } }),
    ]);

    expect(row).toMatchObject({ parentCategory: 'Income', amount: '1200.00' });
  });

  // The whole point of storing a magnitude: a row's sign must mean the same
  // thing whichever connector wrote it, so the side lives in parentCategory.
  it('always stores a positive magnitude', () => {
    const rows = normalizePlaidTransactions([txn({ amount: -99.95 }), txn({ amount: 99.95 })]);

    expect(rows.map((r) => r.amount)).toEqual(['99.95', '99.95']);
  });

  // The mapping that would look harmless and ruin every margin. An owner moving
  // money between their own accounts is neither revenue nor a cost.
  it('keeps transfers out of both sides', () => {
    const rows = normalizePlaidTransactions([
      txn({ amount: -5000, personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_DEPOSIT' } }),
      txn({ amount: 5000, personal_finance_category: { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_WITHDRAWAL' } }),
    ]);

    expect(rows.map((r) => r.parentCategory)).toEqual(['Other', 'Other']);
  });

  // Money handed back to a customer. Positive Expenses row rather than a
  // negative sale, matching what QuickBooks, Shopify and Square all write.
  it('treats an income reversal as a positive refund expense', () => {
    const [row] = normalizePlaidTransactions([
      txn({ amount: 300, personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_OTHER_INCOME' } }),
    ]);

    expect(row).toMatchObject({ parentCategory: 'Expenses', category: 'Refunds', amount: '300.00' });
  });

  // The mirror case. Netting a refunded cost into Income would read as revenue
  // growth; 'Other' keeps it out of both sides instead.
  it('keeps a refunded cost out of Income', () => {
    const [row] = normalizePlaidTransactions([
      txn({ amount: -75, personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_TAXI' } }),
    ]);

    expect(row!.parentCategory).toBe('Other');
  });

  // Pending and settled are two transaction_ids for one purchase, so keeping
  // both double-counts it. A pending transaction can also never settle.
  it('skips pending transactions', () => {
    const rows = normalizePlaidTransactions([
      txn({ transaction_id: 'pending-1', pending: true }),
      txn({ transaction_id: 'settled-1', pending: false, pending_transaction_id: 'pending-1' }),
    ]);

    expect(rows.map((r) => r.sourceId)).toEqual(['settled-1']);
  });

  it('falls back to the direction of the money when Plaid sent no category', () => {
    const rows = normalizePlaidTransactions([
      txn({ amount: 20, personal_finance_category: null }),
      txn({ amount: -20, personal_finance_category: null }),
    ]);

    expect(rows.map((r) => r.parentCategory)).toEqual(['Expenses', 'Income']);
    expect(rows.map((r) => r.category)).toEqual(['Uncategorized', 'Uncategorized']);
  });

  // A primary Plaid adds after this map was written must not be dropped, and
  // must not be guessed at either; the direction is still known.
  it('falls back on an unrecognised category rather than dropping the row', () => {
    const [row] = normalizePlaidTransactions([
      txn({ amount: 60, personal_finance_category: { primary: 'CRYPTO_SOMETHING_NEW', detailed: 'X' } }),
    ]);

    expect(row).toMatchObject({ parentCategory: 'Expenses', amount: '60.00' });
  });

  // DW-287: counterparty has to be groupable, so it holds the merchant and not
  // the bank's description string.
  it('puts the merchant in counterparty and the raw description in label', () => {
    const [row] = normalizePlaidTransactions([txn()]);

    expect(row).toMatchObject({
      counterparty: 'Blue Bottle Coffee',
      label: 'SQ *BLUE BOTTLE 4411',
    });
  });

  it('leaves counterparty null when Plaid resolved no merchant', () => {
    const [row] = normalizePlaidTransactions([txn({ merchant_name: null })]);

    expect(row!.counterparty).toBeNull();
    expect(row!.label).toBe('SQ *BLUE BOTTLE 4411');
  });

  it('titles the category from Plaid primary so it groups with the other sources', () => {
    const [row] = normalizePlaidTransactions([txn()]);

    expect(row!.category).toBe('Food And Drink');
  });

  // A date string with no zone parsed in a non-UTC runner would land a day
  // early, which silently moves a transaction between months.
  it('parses the date at UTC midnight', () => {
    const [row] = normalizePlaidTransactions([txn({ date: '2026-11-01' })]);

    expect(row!.date.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('carries the Plaid ids in metadata for reconciliation', () => {
    const [row] = normalizePlaidTransactions([txn({ transaction_id: 'tx-9', account_id: 'acct-9' })]);

    expect(row!.metadata).toEqual({
      plaid_transaction_id: 'tx-9',
      plaid_account_id: 'acct-9',
      pfc_primary: 'FOOD_AND_DRINK',
    });
  });

  it('uses the Plaid transaction id as the row identity', () => {
    const [row] = normalizePlaidTransactions([txn({ transaction_id: 'tx-abc' })]);

    expect(row!.sourceId).toBe('tx-abc');
  });
});
