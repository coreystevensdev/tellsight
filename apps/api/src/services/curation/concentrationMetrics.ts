import { financialEffect, monthKey, parseAmount, type DataRow } from './computationPrimitives.js';
import type { CustomerConcentrationStat } from './types.js';
import { StatType } from './types.js';

/**
 * How much of revenue comes from the single largest customer.
 *
 * The arithmetic is a group-by. The whole difficulty is that a naive one is
 * indistinguishable from a real finding: three attributed rows out of four
 * hundred, one of them large, produces the same "top customer 60%" as a business
 * genuinely dependent on one client. Only one of those is worth telling anyone.
 *
 * **The guard is derived rather than chosen, and that is deliberate.** A fixed
 * coverage threshold (70%? 50%?) would be a number nobody could defend. Instead
 * it comes from what the stat actually claims, which is that a named customer is
 * the *largest*. That claim fails exactly when the revenue carrying no
 * counterparty could, by itself, belong to someone bigger. So:
 *
 *   suppress when unattributed revenue >= the top customer's revenue
 *
 * At that point an unknown single payer could match or beat the one being named
 * and "largest" is a coin flip. Below it, the claim holds no matter how the
 * unattributed revenue is distributed, because even all of it in one place
 * cannot outrank the leader.
 *
 * The denominator is total revenue, attributed and not. That is what makes the
 * rule above sufficient: the reported percentage is then a floor on the
 * customer's real share rather than a share of some arbitrary subset. Dividing
 * by attributed revenue instead would inflate every figure by exactly the
 * coverage gap, which is the error the guard exists to prevent.
 *
 * A consequence worth stating, because it looks wrong at a glance: coverage can
 * be very low and the stat still fire. One $100 customer against ninety-nine
 * unattributed $1 rows reports 50.3%, and that is true. Coverage is not the
 * thing that matters; whether the gap can hide a bigger customer is.
 *
 * Also suppressed below two months, matching taxMetrics: one billing cycle is
 * not a concentration pattern, and an annual invoice landing in January would
 * otherwise read as total dependency.
 */
export function computeCustomerConcentration(rows: DataRow[]): CustomerConcentrationStat[] {
  const months = new Set<string>();
  const byCustomer = new Map<string, number>();
  let attributed = 0;
  let unattributed = 0;

  for (const row of rows) {
    const amount = parseAmount(row.amount);
    if (amount === null) continue;
    const effect = financialEffect(row);
    // Revenue only. A vendor taking 60% of spend is supplier risk, which reads
    // differently from customer risk even though the group-by is identical.
    if (!effect || effect.side !== 'Income') continue;

    const signed = effect.sign * amount;
    months.add(monthKey(row.date));

    const name = row.counterparty?.trim();
    if (!name) {
      unattributed += signed;
      continue;
    }
    attributed += signed;
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + signed);
  }

  const monthsCovered = months.size;
  if (monthsCovered < 2) return [];

  const totalRevenue = attributed + unattributed;
  if (totalRevenue <= 0) return [];
  if (byCustomer.size === 0) return [];

  const ranked = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]);
  const [topCustomer, topRevenue] = ranked[0]!;
  if (topRevenue <= 0) return [];

  // The derived guard. No clamp needed: refunds can make unattributed negative,
  // and a negative is already below a positive topRevenue, so a credit can never
  // widen the gap. The details below do clamp, because reporting a negative
  // "not attributed to a customer" figure would read as a mistake.
  if (unattributed >= topRevenue) return [];

  const sharePercent = (topRevenue / totalRevenue) * 100;

  return [
    {
      statType: StatType.CustomerConcentration,
      category: null,
      value: Math.round(sharePercent * 10) / 10,
      // Customers, not rows or months: the figure's weakness is a book with few
      // distinct payers, and one customer of one is the strongest version of
      // this finding rather than the weakest.
      sampleSize: byCustomer.size,
      details: {
        topCustomer,
        topCustomerRevenue: Math.round(topRevenue),
        sharePercent: Math.round(sharePercent * 10) / 10,
        totalRevenue: Math.round(totalRevenue),
        attributedRevenue: Math.round(attributed),
        unattributedRevenue: Math.round(Math.max(unattributed, 0)),
        customerCount: byCustomer.size,
        monthsCovered,
      },
    },
  ];
}
