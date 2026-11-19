import { describe, expect, it } from 'vitest';

import { normalizeTransaction, normalizeTransactions, parseXeroDate } from './normalize.js';
import type { XeroEntity, XeroTransaction, XeroTransactionType } from './types.js';

const ACCOUNTS = new Map([
  ['200', 'Sales'],
  ['445', 'Electricity'],
]);

// 2014-05-26T00:00:00Z, the shape Xero actually sends in JSON.
const XERO_DATE = '/Date(1401062400000+0000)/';

function tx(over: Partial<XeroTransaction> = {}): XeroTransaction {
  return {
    id: 'inv-1',
    Type: 'ACCREC',
    Status: 'AUTHORISED',
    Date: XERO_DATE,
    Contact: { Name: 'Acme Ltd' },
    LineItems: [{ LineItemID: 'line-1', LineAmount: '100.00', AccountCode: '200' }],
    Total: '100.00',
    ...over,
  };
}

function rows(transaction: XeroTransaction, entity: XeroEntity = 'Invoices') {
  return normalizeTransaction(transaction, entity, ACCOUNTS);
}

describe('status gating', () => {
  // The expensive one. A voided invoice keeps its full Total, so counting it
  // reports revenue the business explicitly took back.
  it.each(['DRAFT', 'SUBMITTED', 'VOIDED', 'DELETED'])('produces nothing for %s', (Status) => {
    expect(rows(tx({ Status }))).toEqual([]);
  });

  it.each(['AUTHORISED', 'PAID'])('counts an invoice at %s', (Status) => {
    expect(rows(tx({ Status }))).toHaveLength(1);
  });

  // A bank transaction has no PAID state, so accepting one would mean accepting
  // a status Xero never sends here rather than widening anything real.
  it('counts a bank transaction only at AUTHORISED', () => {
    const base = { id: 'bt-1', Type: 'SPEND' as XeroTransactionType, Date: XERO_DATE };
    expect(
      rows({ ...base, Status: 'AUTHORISED', Total: '50', LineItems: [] }, 'BankTransactions'),
    ).toHaveLength(1);
    expect(
      rows({ ...base, Status: 'VOIDED', Total: '50', LineItems: [] }, 'BankTransactions'),
    ).toEqual([]);
  });

  it('produces nothing for an absent status rather than assuming approval', () => {
    expect(rows(tx({ Status: undefined }))).toEqual([]);
  });
});

describe('which side of the ledger', () => {
  it('puts a sales invoice on Income', () => {
    expect(rows(tx())[0]).toMatchObject({ parentCategory: 'Income', amount: '100' });
  });

  it('puts a bill on Expenses', () => {
    expect(rows(tx({ Type: 'ACCPAY' }))[0]!.parentCategory).toBe('Expenses');
  });

  // A credit note to a customer is a refund, matching what the QuickBooks and
  // Shopify normalizers do with theirs so the sign means one thing whichever
  // connector wrote the row.
  it('writes a customer credit note as a positive Expenses row categorized Refunds', () => {
    const [row] = rows(tx({ Type: 'ACCRECCREDIT' }), 'CreditNotes');

    expect(row).toMatchObject({ parentCategory: 'Expenses', category: 'Refunds', amount: '100' });
  });

  // A vendor crediting the business reduces what is owed: the expense side
  // without being an expense (DW-235).
  it('writes a vendor credit note as ExpensesContra', () => {
    expect(rows(tx({ Type: 'ACCPAYCREDIT' }), 'CreditNotes')[0]!.parentCategory).toBe(
      'ExpensesContra',
    );
  });

  /**
   * The worst of the lot if it were wrong. One transfer between the org's own
   * accounts comes back as two rows, so counting them adds the same money to
   * revenue *and* expenses: both inflated, profit unchanged, nothing obviously
   * broken on the dashboard.
   */
  it.each(['RECEIVE-TRANSFER', 'SPEND-TRANSFER'] as const)(
    'keeps %s off both sides',
    (Type) => {
      expect(rows(tx({ Type, id: 'bt-1' }), 'BankTransactions')[0]!.parentCategory).toBe('Other');
    },
  );

  // Cash with no invoice behind it yet. Counting it now and again when the
  // invoice lands double-counts it.
  it.each([
    'RECEIVE-PREPAYMENT',
    'SPEND-PREPAYMENT',
    'RECEIVE-OVERPAYMENT',
    'SPEND-OVERPAYMENT',
  ] as const)('keeps %s off both sides', (Type) => {
    expect(rows(tx({ Type, id: 'bt-1' }), 'BankTransactions')[0]!.parentCategory).toBe('Other');
  });

  it.each(['RECEIVE', 'SPEND'] as const)('counts a plain %s', (Type) => {
    const [row] = rows(tx({ Type, id: 'bt-1' }), 'BankTransactions');
    expect(row!.parentCategory).toBe(Type === 'RECEIVE' ? 'Income' : 'Expenses');
  });

  it('classifies a type it does not recognise as Other rather than guessing a side', () => {
    const [row] = rows(tx({ Type: 'SOMETHING-NEW' as XeroTransactionType }));
    expect(row!.parentCategory).toBe('Other');
  });
});

describe('a negative line amount', () => {
  // An invoice of 100 less a 20 discount is 80. Abs()ing the discount reports
  // 120 and dropping it reports 100.
  it('becomes a contra row on the same side, so the invoice nets correctly', () => {
    const result = rows(
      tx({
        LineItems: [
          { LineItemID: 'a', LineAmount: '100.00', AccountCode: '200' },
          { LineItemID: 'b', LineAmount: '-20.00', AccountCode: '200' },
        ],
      }),
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ parentCategory: 'Income', amount: '100' });
    // Positive amount under a contra parent, never a negative amount: charts.ts
    // abs()es amounts, so a negative would be undone in the chart path while
    // working in the stat path.
    expect(result[1]).toMatchObject({ parentCategory: 'IncomeContra', amount: '20' });
  });

  it('becomes ExpensesContra on a bill', () => {
    const [row] = rows(
      tx({ Type: 'ACCPAY', LineItems: [{ LineItemID: 'a', LineAmount: '-30', AccountCode: '445' }] }),
    );

    expect(row).toMatchObject({ parentCategory: 'ExpensesContra', amount: '30' });
  });

  // 'Other' has no contra form and nothing reads its sign, so a negative
  // transfer line must not invent a parent category that does not exist.
  it('stays Other on a transfer', () => {
    const [row] = rows(
      tx({
        Type: 'SPEND-TRANSFER',
        id: 'bt-1',
        LineItems: [{ LineItemID: 'a', LineAmount: '-500' }],
      }),
      'BankTransactions',
    );

    expect(row!.parentCategory).toBe('Other');
  });
});

describe('dates', () => {
  it('reads the epoch out of the .NET date format Xero sends', () => {
    expect(rows(tx())[0]!.date.toISOString()).toBe('2014-05-26T00:00:00.000Z');
  });

  it('parses a negative epoch, which is any date before 1970', () => {
    expect(parseXeroDate('/Date(-86400000+0000)/')!.toISOString()).toBe('1969-12-31T00:00:00.000Z');
  });

  // DateString carries no zone, so new Date reads it as the server's local
  // time. Only the fallback, never the first choice.
  it('falls back to DateString when there is no epoch form', () => {
    expect(parseXeroDate(undefined, '2014-05-26T00:00:00')).not.toBeNull();
  });

  it('prefers the epoch form over DateString when both are present', () => {
    const parsed = parseXeroDate(XERO_DATE, '1999-01-01T00:00:00');
    expect(parsed!.toISOString()).toBe('2014-05-26T00:00:00.000Z');
  });

  it('reports nothing for an unparseable date', () => {
    expect(parseXeroDate('not-a-date', undefined)).toBeNull();
  });

  // A row with no date cannot be bucketed into a month, which is what every
  // stat groups by, so it would sit in the table contributing to nothing.
  it('drops a transaction with no usable date', () => {
    expect(rows(tx({ Date: undefined, DateString: undefined }))).toEqual([]);
  });
});

describe('currency', () => {
  it('leaves a base-currency amount alone', () => {
    expect(rows(tx({ CurrencyRate: '1.000000' }))[0]!.amount).toBe('100');
  });

  it('converts into the base currency with the rate Xero computed', () => {
    const [row] = rows(tx({ CurrencyRate: '0.5', CurrencyCode: 'GBP' }));

    expect(row!.amount).toBe('50');
    expect(row!.metadata.currency).toBe('GBP');
  });

  it('treats an absent rate as 1 rather than as zero', () => {
    expect(rows(tx({ CurrencyRate: undefined }))[0]!.amount).toBe('100');
  });

  // A zero or negative rate would silently erase every amount on the
  // transaction, which is worse than reporting it unconverted.
  it.each(['0', '-1'])('ignores a nonsensical rate of %s', (CurrencyRate) => {
    expect(rows(tx({ CurrencyRate }))[0]!.amount).toBe('100');
  });
});

describe('categories and counterparty', () => {
  it('names the category from the account code', () => {
    expect(rows(tx())[0]!.category).toBe('Sales');
  });

  // "445" is poor but it is the real account. Collapsing every unknown code
  // into one bucket would lose the breakdown entirely.
  it('falls back to the bare code when the accounts lookup is empty', () => {
    const [row] = normalizeTransaction(tx(), 'Invoices', new Map());
    expect(row!.category).toBe('200');
  });

  it('reports Uncategorized when a line carries no account code', () => {
    const [row] = rows(tx({ LineItems: [{ LineItemID: 'a', LineAmount: '10' }] }));
    expect(row!.category).toBe('Uncategorized');
  });

  it('takes the counterparty from the contact name', () => {
    expect(rows(tx())[0]!.counterparty).toBe('Acme Ltd');
  });

  it('reports no counterparty rather than a blank one', () => {
    expect(rows(tx({ Contact: { Name: '   ' } }))[0]!.counterparty).toBeNull();
  });

  // label falls back across several fields and so cannot be grouped on, which
  // is the whole reason counterparty is its own column (DW-280).
  it('keeps label and counterparty separate', () => {
    const [row] = rows(tx({ Reference: 'INV-0042' }));

    expect(row!.label).toBe('INV-0042');
    expect(row!.counterparty).toBe('Acme Ltd');
  });

  it('falls back to the contact for a label when nothing else is written', () => {
    const [row] = rows(tx({ Reference: undefined, InvoiceNumber: undefined }));
    expect(row!.label).toBe('Acme Ltd');
  });
});

describe('row identity and shape', () => {
  it('keys a row on entity, transaction and line so two entities cannot collide', () => {
    expect(rows(tx())[0]!.sourceId).toBe('Invoices-inv-1-line-1');
  });

  // A line with no id of its own still needs a stable distinct key, and the
  // prefix keeps generated keys out of Xero's own id space.
  it('synthesizes a line key when Xero sends none', () => {
    const result = rows(
      tx({ LineItems: [{ LineAmount: '10' }, { LineAmount: '20' }] }),
    );

    expect(result.map((r) => r.sourceId)).toEqual(['Invoices-inv-1-i0', 'Invoices-inv-1-i1']);
  });

  it('records the entity and type for the reconcile to key on', () => {
    expect(rows(tx())[0]!.metadata).toMatchObject({
      xero_id: 'inv-1',
      entity: 'Invoices',
      txnType: 'ACCREC',
      accountCode: '200',
    });
  });

  it('produces one row per line item', () => {
    const result = rows(
      tx({
        LineItems: [
          { LineItemID: 'a', LineAmount: '60', AccountCode: '200' },
          { LineItemID: 'b', LineAmount: '40', AccountCode: '200' },
        ],
      }),
    );

    expect(result.map((r) => r.amount)).toEqual(['60', '40']);
  });

  // The paging fix in api.ts is what makes line items arrive at all. This is
  // the degraded path for a payload that has none.
  it('falls back to one row off the total when there are no line items', () => {
    const [row] = rows(tx({ LineItems: [] }));

    expect(row).toMatchObject({ amount: '100', category: 'Uncategorized', sourceId: 'Invoices-inv-1-0' });
  });

  it('drops a transaction with neither line items nor a total', () => {
    expect(rows(tx({ LineItems: [], Total: undefined }))).toEqual([]);
  });

  it('skips a zero-amount line rather than writing a row worth nothing', () => {
    const result = rows(
      tx({
        LineItems: [
          { LineItemID: 'a', LineAmount: '0' },
          { LineItemID: 'b', LineAmount: '25', AccountCode: '200' },
        ],
      }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.amount).toBe('25');
  });

  it('skips a line whose amount cannot be parsed', () => {
    const result = rows(
      tx({
        LineItems: [
          { LineItemID: 'a', LineAmount: 'nonsense' },
          { LineItemID: 'b', LineAmount: '25', AccountCode: '200' },
        ],
      }),
    );

    expect(result.map((r) => r.sourceId)).toEqual(['Invoices-inv-1-b']);
  });

  it('accepts a numeric line amount as well as a stringified one', () => {
    expect(rows(tx({ LineItems: [{ LineItemID: 'a', LineAmount: 42 }] }))[0]!.amount).toBe('42');
  });
});

describe('normalizeTransactions', () => {
  it('flattens every transaction in the batch', () => {
    const result = normalizeTransactions(
      [tx({ id: 'a' }), tx({ id: 'b' }), tx({ id: 'c', Status: 'VOIDED' })],
      'Invoices',
      ACCOUNTS,
    );

    expect(result.map((r) => r.metadata.xero_id)).toEqual(['a', 'b']);
  });
});
