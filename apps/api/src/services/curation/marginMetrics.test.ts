import { describe, it, expect } from 'vitest';

import { computeMarginTrend } from './marginMetrics.js';
import { hasCostVisibility } from './computationPrimitives.js';
import type { DataRow } from 'shared/types';

let nextId = 1;
function row(
  sourceType: string,
  parentCategory: 'Income' | 'Expenses',
  category: string,
  month: string,
  amount: number,
): DataRow {
  return {
    id: nextId++,
    orgId: 1,
    datasetId: 1,
    sourceType,
    category,
    parentCategory,
    date: new Date(`${month}-15T00:00:00Z`),
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(`${month}-15T00:00:00Z`),
  } as unknown as DataRow;
}

const MONTHS = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12'];

/** Six months of orders with a 3% refund rate and no operating-cost rows, which
 *  is every row a Shopify or Square sync can produce. */
function revenueOnly(source: string): DataRow[] {
  return MONTHS.flatMap((m, i) => [
    row(source, 'Income', 'Online Sales', m, 100_000 + i * 2_000),
    row(source, 'Expenses', 'Refunds', m, 3_000 + i * 50),
  ]);
}

function realCosts(source: string): DataRow[] {
  return MONTHS.flatMap((m, i) => [
    row(source, 'Expenses', 'COGS', m, 55_000 + i * 1_200),
    row(source, 'Expenses', 'Payroll', m, 22_000),
  ]);
}

describe('hasCostVisibility', () => {
  it('is false when every expense row came from a revenue-only source', () => {
    expect(hasCostVisibility(revenueOnly('shopify'))).toBe(false);
    expect(hasCostVisibility(revenueOnly('square'))).toBe(false);
    expect(hasCostVisibility(revenueOnly('stripe'))).toBe(false);
  });

  it('is true as soon as one accounting source contributes an expense row', () => {
    // The mixed org. Shopify carries the sales, QuickBooks carries the costs,
    // and the margin is real, so suppressing here would be the wrong answer.
    expect(hasCostVisibility([...revenueOnly('shopify'), ...realCosts('quickbooks')])).toBe(true);
  });

  it('is false when a cost-visible source contributed only income', () => {
    const rows = [
      ...revenueOnly('square'),
      row('quickbooks', 'Income', 'Consulting', '2025-09', 5_000),
    ];
    expect(hasCostVisibility(rows)).toBe(false);
  });

  it('treats a CSV as cost-visible, because the owner chose the columns', () => {
    expect(hasCostVisibility(revenueOnly('csv'))).toBe(true);
  });

  it('treats an absent source as cost-visible rather than suppressing', () => {
    // Reachable by type, not by the current call sites: SourceRow is a Pick that
    // drops sourceType and sourceRows.ts passes rows of that shape around this
    // layer. Erring visible keeps the predicate subtractive.
    expect(hasCostVisibility([{ parentCategory: 'Expenses' }])).toBe(true);
    expect(hasCostVisibility([{ sourceType: null, parentCategory: 'Expenses' }])).toBe(true);
  });

  it('treats a source outside the enum as cost-visible', () => {
    expect(hasCostVisibility([{ sourceType: 'paypal', parentCategory: 'Expenses' }])).toBe(true);
  });
});

describe('computeMarginTrend', () => {
  it('suppresses a revenue-only source instead of reporting a refund-only margin', () => {
    // Before this guard the same rows reported recentMarginPercent 97: revenue
    // minus refunds, for a business whose real margin is roughly a fifth of that.
    expect(computeMarginTrend(revenueOnly('shopify'))).toEqual([]);
  });

  it('reports the real margin once an accounting source supplies the costs', () => {
    const stats = computeMarginTrend([...revenueOnly('shopify'), ...realCosts('quickbooks')]);
    expect(stats).toHaveLength(1);
    // 21.3 rather than 97, and the gap between those two numbers is the defect.
    expect(stats[0]!.details.recentMarginPercent).toBeCloseTo(21.3, 0);
  });

  it('still suppresses when there are no expense rows at all', () => {
    // DW-252's case, which the new guard must not paper over.
    const incomeOnly = MONTHS.map((m, i) => row('csv', 'Income', 'Sales', m, 100_000 + i * 2_000));
    expect(computeMarginTrend(incomeOnly)).toEqual([]);
  });
});
