import type { PlaidAccount } from './types.js';

export interface CashOnHand {
  balance: number;
  currency: string;
  accountCount: number;
  /** Depository subtypes present but excluded as unspendable, for the log. */
  skippedSubtypes: string[];
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
/**
 * Depository subtypes the business cannot actually spend.
 *
 * The type filter below already removes the dangerous cases, credit and loans
 * and investments. These are the ones that survive it and still are not cash a
 * business can reach to make payroll: a `cd` is locked until maturity, an `hsa`
 * is restricted to qualified medical expenses under tax penalty, `ebt` is
 * government benefits, and `limited purpose checking` is restricted by
 * definition (Plaid's own description, and it is opt-in only so it should never
 * arrive here at all).
 *
 * A **denylist**, not an allowlist, and the choice matters. An allowlist is the
 * more conservative shape and would be right if the only risk were overstating,
 * but `subtype` is nullable and some institutions do not report one. An
 * allowlist would silently drop a plain checking account from such an
 * institution and report a fraction of the real balance, which is a worse
 * failure than counting a CD: it is large, silent, and hits ordinary accounts
 * rather than unusual ones.
 *
 * The residual risk is named rather than hidden: a restricted subtype Plaid
 * adds later counts as cash until this list is updated. That is bounded, since
 * the type filter catches every large category, and the skip is logged so a
 * figure that looks wrong can be explained.
 */
const NOT_SPENDABLE_SUBTYPES = new Set([
  'cd',
  'hsa',
  'ebt',
  'limited purpose checking',
]);

function isSpendable(a: PlaidAccount): boolean {
  if (a.type !== 'depository') return false;
  // A null subtype counts. See the denylist comment above: dropping it would
  // zero out an ordinary account at an institution that reports no subtype.
  const subtype = a.subtype?.toLowerCase().trim();
  return !subtype || !NOT_SPENDABLE_SUBTYPES.has(subtype);
}

export function cashFromAccounts(accounts: PlaidAccount[]): CashOnHand | null {
  const spendable = accounts.filter(
    (a) => isSpendable(a) && (a.balances.available ?? a.balances.current) !== null,
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
    // Named so the caller can say which accounts were left out and why, rather
    // than an owner seeing a figure lower than their bank app and having no way
    // to reconcile it.
    skippedSubtypes: [
      ...new Set(
        accounts
          .filter((a) => a.type === 'depository' && !isSpendable(a))
          .map((a) => a.subtype!.toLowerCase().trim()),
      ),
    ].sort(),
  };
}
