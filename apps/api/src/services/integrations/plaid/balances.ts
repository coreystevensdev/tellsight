import type { PlaidAccount } from './types.js';

export interface CashOnHand {
  balance: number;
  currency: string;
  accountCount: number;
}

/**
 * How much cash the business can actually reach, from a set of Plaid accounts.
 *
 * `runway` and `cash_forecast` have never fired for any org, because both read
 * `financials.cashOnHand` and nothing but an owner typing a number has ever
 * supplied one. A bank connection can, and this is the part of that worth
 * testing without a network.
 *
 * Three decisions, each of which is wrong in an obvious direction if reversed:
 *
 *   - **Depository accounts only.** Plaid reports a `credit` account's `current`
 *     as the amount *owed*, so adding a credit card does not add cash, it adds
 *     debt while making runway look longer. `loan` and `investment` are excluded
 *     for the same reason in reverse: a mortgage principal is not spendable and
 *     neither is an illiquid holding.
 *   - **`available` before `current`.** Available subtracts pending outflows,
 *     which is the honest answer to "how long can I keep paying". Not every
 *     institution calculates it, and Plaid returns null when it does not, so
 *     `current` is the fallback rather than the default.
 *   - **One currency or nothing.** Summing GBP into USD produces a number that
 *     is wrong by an exchange rate nobody chose. A mixed-currency Item
 *     suppresses rather than guessing, which matches how every other stat here
 *     handles data it cannot honestly combine.
 */
export function cashFromAccounts(accounts: PlaidAccount[]): CashOnHand | null {
  const spendable = accounts.filter(
    (a) => a.type === 'depository' && (a.balances.available ?? a.balances.current) !== null,
  );
  if (spendable.length === 0) return null;

  const currencies = new Set(spendable.map((a) => a.balances.iso_currency_code ?? 'unknown'));
  if (currencies.size > 1) return null;

  const [currency] = [...currencies];
  if (currency === 'unknown') return null;

  const balance = spendable.reduce(
    (sum, a) => sum + (a.balances.available ?? a.balances.current ?? 0),
    0,
  );

  return {
    // Two decimal places: this lands in a numeric(14,2) column, and a float sum
    // of several accounts drifts in the cents.
    balance: Math.round(balance * 100) / 100,
    currency: currency!,
    accountCount: spendable.length,
  };
}
