import { describe, expect, it } from 'vitest';

import { cashFromAccounts } from './balances.js';
import type { PlaidAccount } from './types.js';

function account(over: Partial<PlaidAccount> & { available?: number | null; current?: number | null } = {}): PlaidAccount {
  const { available = 1000, current = 1200, ...rest } = over;
  return {
    account_id: 'acct-1',
    name: 'Plaid Checking',
    mask: '0000',
    type: 'depository',
    subtype: 'checking',
    balances: {
      available,
      current,
      limit: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
    },
    ...rest,
  };
}

describe('cashFromAccounts', () => {
  it('sums the depository accounts', () => {
    expect(
      cashFromAccounts([
        account({ account_id: 'a', available: 1000 }),
        account({ account_id: 'b', available: 2500, subtype: 'savings' }),
      ]),
    ).toEqual({ balance: 3500, currency: 'USD', accountCount: 2, skippedSubtypes: [] });
  });

  // The one that is wrong in the worst direction. Plaid reports a credit
  // account's current balance as the amount owed, so counting it would add debt
  // to cash and make runway look longer than it is.
  it('excludes a credit card, whose balance is money owed', () => {
    const cash = cashFromAccounts([
      account({ account_id: 'a', available: 1000 }),
      account({
        account_id: 'card',
        type: 'credit',
        subtype: 'credit card',
        available: null,
        current: 410,
      }),
    ]);

    expect(cash).toEqual({ balance: 1000, currency: 'USD', accountCount: 1, skippedSubtypes: [] });
  });

  it.each([
    ['loan', 'student'],
    ['investment', 'brokerage'],
  ])('excludes a %s account, which is not spendable', (type, subtype) => {
    const cash = cashFromAccounts([
      account({ account_id: 'a', available: 1000 }),
      account({ account_id: 'x', type, subtype, available: null, current: 65_262 }),
    ]);

    expect(cash!.balance).toBe(1000);
  });

  // Available subtracts pending outflows, which is the honest answer to "how
  // long can I keep paying".
  it('prefers available over current', () => {
    expect(cashFromAccounts([account({ available: 900, current: 1200 })])!.balance).toBe(900);
  });

  // Not every institution calculates available, and Plaid returns null when it
  // does not, so current is a fallback rather than something to ignore.
  it('falls back to current when the institution reports no available balance', () => {
    expect(cashFromAccounts([account({ available: null, current: 1200 })])!.balance).toBe(1200);
  });

  it('skips an account with neither balance rather than counting it as zero', () => {
    const cash = cashFromAccounts([
      account({ account_id: 'a', available: 500 }),
      account({ account_id: 'b', available: null, current: null }),
    ]);

    expect(cash).toEqual({ balance: 500, currency: 'USD', accountCount: 1, skippedSubtypes: [] });
  });

  // Summing GBP into USD produces a number wrong by an exchange rate nobody
  // chose, so a mixed Item reports nothing rather than a plausible figure.
  it('reports nothing when the accounts are in different currencies', () => {
    const gbp = account({ account_id: 'b', available: 2000 });
    gbp.balances.iso_currency_code = 'GBP';

    expect(cashFromAccounts([account({ account_id: 'a' }), gbp])).toBeNull();
  });

  it('sums a single non-USD currency rather than requiring USD', () => {
    const a = account({ account_id: 'a', available: 1000 });
    const b = account({ account_id: 'b', available: 500 });
    a.balances.iso_currency_code = 'CAD';
    b.balances.iso_currency_code = 'CAD';

    expect(cashFromAccounts([a, b])).toEqual({ balance: 1500, currency: 'CAD', accountCount: 2, skippedSubtypes: [] });
  });

  it('reports nothing when the currency is unstated', () => {
    const a = account();
    a.balances.iso_currency_code = null;

    expect(cashFromAccounts([a])).toBeNull();
  });

  it('reports nothing when the Item holds no depository account', () => {
    expect(
      cashFromAccounts([account({ type: 'credit', subtype: 'credit card', available: null, current: 410 })]),
    ).toBeNull();
  });

  it('reports nothing for an empty account list', () => {
    expect(cashFromAccounts([])).toBeNull();
  });

  // A float sum across several accounts drifts in the cents, and this lands in a
  // numeric(14,2) column.
  it('rounds to cents', () => {
    const cash = cashFromAccounts([
      account({ account_id: 'a', available: 0.1 }),
      account({ account_id: 'b', available: 0.2 }),
    ]);

    expect(cash!.balance).toBe(0.3);
  });

  // An overdrawn account is real and the owner should see it, rather than the
  // product quietly flooring it at zero.
  it('keeps a negative balance', () => {
    expect(cashFromAccounts([account({ available: -250 })])!.balance).toBe(-250);
  });

  // Plaid adds account types; an unrecognised one must fall through the filter
  // rather than be guessed at as cash.
  it('ignores an account type it does not recognise', () => {
    expect(
      cashFromAccounts([account({ type: 'crypto_exchange', available: 50_000 })]),
    ).toBeNull();
  });
});

/**
 * Within `depository`, some subtypes are money the business owns and cannot
 * reach. Runway answers "how long can I keep paying", so counting them
 * overstates it, which is the dangerous direction: it tells an owner they have
 * more time than they do.
 *
 * Found by connecting a Plaid sandbox item with a CD selected on purpose. The
 * balance came back as 1300, which was Checking 100 plus Saving 200 plus a
 * 1000 certificate of deposit locked until maturity.
 */
describe('cashFromAccounts excludes depository accounts that are not spendable', () => {
  function depository(subtype: string, available: number, id = subtype) {
    return account({ account_id: id, subtype, available, current: available });
  }

  it.each([
    ['cd', 'locked until maturity'],
    ['hsa', 'restricted to qualified medical expenses'],
    ['ebt', 'government benefits, not business cash'],
    ['limited purpose checking', 'restricted by definition'],
  ])('leaves out a %s account, %s', (subtype) => {
    const cash = cashFromAccounts([
      depository('checking', 100, 'c'),
      depository(subtype, 50_000),
    ])!;

    expect(cash.balance).toBe(100);
    expect(cash.accountCount).toBe(1);
  });

  it.each(['checking', 'savings', 'money market', 'cash management', 'paypal', 'prepaid'])(
    'still counts a %s account',
    (subtype) => {
      expect(cashFromAccounts([depository(subtype, 250)])!.balance).toBe(250);
    },
  );

  // The reason this is a denylist rather than an allowlist. `subtype` is
  // nullable and some institutions report none; an allowlist would drop an
  // ordinary checking account and report a fraction of the real balance, which
  // is a larger and quieter error than counting a CD.
  it('counts a depository account whose subtype is missing', () => {
    const cash = cashFromAccounts([account({ subtype: null, available: 900 })]);

    expect(cash!.balance).toBe(900);
  });

  it('counts a subtype it has never heard of, which is the denylist trade-off', () => {
    expect(cashFromAccounts([depository('some-new-subtype', 400)])!.balance).toBe(400);
  });

  it('matches the subtype regardless of case or stray whitespace', () => {
    const cash = cashFromAccounts([
      depository('checking', 100, 'c'),
      depository('  CD  ', 9_000),
    ])!;

    expect(cash.balance).toBe(100);
  });

  // Reported rather than silently dropped, so an owner seeing a figure lower
  // than their banking app can be told which accounts were left out.
  it('names what it skipped', () => {
    const cash = cashFromAccounts([
      depository('checking', 100, 'c'),
      depository('cd', 1_000),
      depository('hsa', 500),
    ])!;

    expect(cash.skippedSubtypes).toEqual(['cd', 'hsa']);
  });

  it('reports nothing when every depository account is unspendable', () => {
    expect(cashFromAccounts([depository('cd', 1_000), depository('hsa', 500)])).toBeNull();
  });

  // The exact sandbox shape that exposed this, as a regression.
  it('reports 300 for the sandbox item that used to report 1300', () => {
    const cash = cashFromAccounts([
      depository('checking', 100, 'chk'),
      depository('savings', 200, 'sav'),
      depository('cd', 1_000, 'cd'),
    ])!;

    expect(cash.balance).toBe(300);
    expect(cash.skippedSubtypes).toEqual(['cd']);
  });
});
