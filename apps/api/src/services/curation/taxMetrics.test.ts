import { describe, expect, it } from 'vitest';

import { computeTaxSetAside } from './taxMetrics.js';
import type { DataRow } from './computationPrimitives.js';

function row(date: string, amount: string, parentCategory: string): DataRow {
  return { category: 'x', parentCategory, date: new Date(date), amount, label: null, metadata: null } as DataRow;
}

// Two months of a profitable business: 10,000 in, 6,000 out, 4,000 profit.
const profitable: DataRow[] = [
  row('2026-09-10', '6000', 'Income'),
  row('2026-09-18', '3500', 'Expenses'),
  row('2026-10-10', '4000', 'Income'),
  row('2026-10-18', '2500', 'Expenses'),
];

describe('computeTaxSetAside', () => {
  it('applies the stated rate to net profit', () => {
    const [stat] = computeTaxSetAside(profitable, 25);

    expect(stat!.details).toMatchObject({
      revenue: 10_000,
      expenses: 6_000,
      netProfit: 4_000,
      ratePercent: 25,
      setAside: 1_000,
      monthsCovered: 2,
    });
    expect(stat!.value).toBe(1_000);
  });

  // The whole legal posture of the stat. A rate the product picked would be
  // advice, and the product never says "you should", so no rate means no stat
  // rather than a default rate.
  it('produces nothing when no rate has been supplied', () => {
    expect(computeTaxSetAside(profitable, null)).toEqual([]);
    expect(computeTaxSetAside(profitable, undefined)).toEqual([]);
    expect(computeTaxSetAside(profitable, 0)).toEqual([]);
  });

  // "Set aside $0" is noise dressed as an insight, and a loss-making period
  // owes no income tax.
  it('produces nothing when the period lost money', () => {
    const loss = [
      row('2026-09-10', '3000', 'Income'),
      row('2026-09-18', '5000', 'Expenses'),
      row('2026-10-10', '2000', 'Income'),
      row('2026-10-18', '4000', 'Expenses'),
    ];

    expect(computeTaxSetAside(loss, 25)).toEqual([]);
  });

  // The case the loss guard would miss: a real profit, but one so small the
  // set-aside rounds to nothing.
  it('produces nothing when the set-aside rounds away', () => {
    const barely = [
      row('2026-09-10', '100', 'Income'),
      row('2026-09-18', '99', 'Expenses'),
      row('2026-10-10', '100', 'Income'),
      row('2026-10-18', '99', 'Expenses'),
    ];

    expect(computeTaxSetAside(barely, 1)).toEqual([]);
  });

  // One month of profit says nothing about what a period will owe.
  it('produces nothing from a single month', () => {
    const oneMonth = [row('2026-10-10', '9000', 'Income'), row('2026-10-18', '1000', 'Expenses')];

    expect(computeTaxSetAside(oneMonth, 25)).toEqual([]);
  });

  // Zero revenue is a dataset that classified nothing, which is a different
  // condition from a real month that lost money, and neither owes income tax.
  it('produces nothing when nothing was classified as income', () => {
    const unclassified = [
      row('2026-09-10', '6000', 'Other'),
      row('2026-10-10', '4000', 'Other'),
    ];

    expect(computeTaxSetAside(unclassified, 25)).toEqual([]);
  });

  // Rounds the money, keeps the rate exactly as given: a rate the owner typed
  // should read back to them unchanged.
  it('rounds the set-aside but reports the rate verbatim', () => {
    const [stat] = computeTaxSetAside(profitable, 22.5);

    expect(stat!.details.ratePercent).toBe(22.5);
    expect(stat!.details.setAside).toBe(900);
  });

  it('counts months rather than rows as its sample size', () => {
    const threeMonths = [
      ...profitable,
      row('2026-11-10', '5000', 'Income'),
      row('2026-11-18', '1000', 'Expenses'),
    ];

    const [stat] = computeTaxSetAside(threeMonths, 25);
    expect(stat!.sampleSize).toBe(3);
  });
});
