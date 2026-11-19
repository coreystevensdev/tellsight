import { describe, expect, it } from 'vitest';

import { computeCustomerConcentration } from './concentrationMetrics.js';
import type { DataRow } from './computationPrimitives.js';

function row(
  date: string,
  amount: string,
  counterparty: string | null,
  parentCategory = 'Income',
): DataRow {
  return { category: 'Sales', parentCategory, date: new Date(date), amount, counterparty, label: null };
}

// Two months minimum, so every fixture spans at least that.
const JAN = '2026-01-10';
const FEB = '2026-02-10';

describe('computeCustomerConcentration', () => {
  it('names the largest customer and its share of total revenue', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '6000', 'Acme'),
      row(FEB, '2000', 'Beta'),
      row(FEB, '2000', 'Gamma'),
    ]);

    expect(stat!.details).toMatchObject({
      topCustomer: 'Acme',
      topCustomerRevenue: 6000,
      sharePercent: 60,
      totalRevenue: 10_000,
      customerCount: 3,
    });
    expect(stat!.value).toBe(60);
  });

  // The guard, stated as the rule it is: suppress when the revenue carrying no
  // counterparty could by itself belong to someone bigger.
  it('suppresses when unattributed revenue could hide a bigger customer', () => {
    const stats = computeCustomerConcentration([
      row(JAN, '3000', 'Acme'),
      row(FEB, '3000', null),
    ]);

    expect(stats).toEqual([]);
  });

  it('fires when the unattributed remainder cannot outrank the leader', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '3000', 'Acme'),
      row(FEB, '2999', null),
    ]);

    expect(stat!.details.topCustomer).toBe('Acme');
    // Floor on the real share: 3000 of 5999, not 3000 of 3000.
    expect(stat!.details.sharePercent).toBeCloseTo(50.0, 1);
  });

  // The case that looks wrong and is right. Coverage is 1%, and the claim still
  // holds because no single unknown payer can beat the leader.
  it('fires on very low coverage when the arithmetic still supports it', () => {
    const rows = [row(JAN, '100', 'Acme')];
    for (let i = 0; i < 99; i++) rows.push(row(FEB, '1', null));

    const [stat] = computeCustomerConcentration(rows);

    expect(stat!.details.sharePercent).toBeCloseTo(50.3, 1);
    expect(stat!.details.unattributedRevenue).toBe(99);
  });

  // Dividing by attributed revenue instead would report 100% here, which is the
  // exact error the guard exists to prevent.
  it('divides by total revenue, not by the attributed subset', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '1000', 'Acme'),
      row(FEB, '900', null),
    ]);

    expect(stat!.details.sharePercent).toBeCloseTo(52.6, 1);
    expect(stat!.details.totalRevenue).toBe(1900);
    expect(stat!.details.attributedRevenue).toBe(1000);
  });

  // A vendor taking most of the spend is supplier risk, a different finding
  // that happens to share a group-by.
  it('ignores expenses entirely', () => {
    const stats = computeCustomerConcentration([
      row(JAN, '9000', 'Big Vendor', 'Expenses'),
      row(FEB, '1000', 'Acme', 'Expenses'),
    ]);

    expect(stats).toEqual([]);
  });

  it('counts only revenue when a counterparty appears on both sides', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '5000', 'Acme'),
      row(JAN, '4000', 'Acme', 'Expenses'),
      row(FEB, '1000', 'Beta'),
    ]);

    expect(stat!.details.topCustomerRevenue).toBe(5000);
    expect(stat!.details.totalRevenue).toBe(6000);
  });

  // One billing cycle is not a concentration pattern: an annual invoice landing
  // in January would otherwise read as total dependency.
  it('produces nothing from a single month', () => {
    expect(
      computeCustomerConcentration([row(JAN, '5000', 'Acme'), row(JAN, '1000', 'Beta')]),
    ).toEqual([]);
  });

  it('produces nothing when no row carries a counterparty', () => {
    expect(
      computeCustomerConcentration([row(JAN, '5000', null), row(FEB, '1000', null)]),
    ).toEqual([]);
  });

  it('produces nothing when there is no revenue', () => {
    expect(
      computeCustomerConcentration([
        row(JAN, '500', 'Acme', 'Expenses'),
        row(FEB, '500', 'Beta', 'Expenses'),
      ]),
    ).toEqual([]);
  });

  // Total dependency on one customer is the strongest form of this finding, not
  // a degenerate case to suppress.
  it('reports 100% for a single-customer book', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '4000', 'Acme'),
      row(FEB, '6000', 'Acme'),
    ]);

    expect(stat!.details).toMatchObject({ sharePercent: 100, customerCount: 1 });
  });

  it('groups a customer written with stray whitespace as one', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '3000', 'Acme'),
      row(FEB, '3000', '  Acme  '),
      row(FEB, '1000', 'Beta'),
    ]);

    expect(stat!.details).toMatchObject({ topCustomer: 'Acme', topCustomerRevenue: 6000, customerCount: 2 });
  });

  it('treats a whitespace-only counterparty as unattributed', () => {
    const stats = computeCustomerConcentration([
      row(JAN, '3000', 'Acme'),
      row(FEB, '   ', null),
    ]);

    // Attributed 3000 against 0 unattributed, so it fires rather than counting
    // a blank string as a customer named "   ".
    expect(stats[0]!.details.customerCount).toBe(1);
  });

  // Refunds make unattributed negative, which cannot hide a larger customer, so
  // the guard must not read a credit as a widening gap.
  it('does not let a refund on unattributed revenue suppress the stat', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '5000', 'Acme'),
      row(FEB, '-400', null),
    ]);

    expect(stat!.details.topCustomer).toBe('Acme');
    expect(stat!.details.unattributedRevenue).toBe(0);
  });

  it('reports the customer count as its sample size', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '5000', 'Acme'),
      row(FEB, '1000', 'Beta'),
      row(FEB, '500', 'Gamma'),
    ]);

    expect(stat!.sampleSize).toBe(3);
  });

  it('skips rows whose amount cannot be parsed', () => {
    const [stat] = computeCustomerConcentration([
      row(JAN, '5000', 'Acme'),
      row(FEB, 'not-a-number', 'Beta'),
      row(FEB, '1000', 'Beta'),
    ]);

    expect(stat!.details.totalRevenue).toBe(6000);
  });
});
