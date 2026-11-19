import { describe, expect, it } from 'vitest';

import { cashFlowForAlerting, cashFlowFromBuckets, computeCashFlow } from './cashFlowMetrics.js';
import { computeCashForecast } from './cashForecastMetrics.js';
import { computeRunway } from './financialMetrics.js';
import type { DataRow } from './computationPrimitives.js';

/**
 * A revenue-only connector's cash-flow figure is wrong rather than missing
 * (DW-295). Shopify and Square write an `Expenses` row for a refund and for
 * nothing else, so revenue minus expenses is approximately revenue, and the
 * stat reports a healthy surplus for a business paying rent it cannot see.
 *
 * This is the DW-261 shape that `marginMetrics.ts` already guards. What makes
 * cash flow harder is that the module's row-access seam is `bucketRowsByMonth`,
 * and a bucket carries no `sourceType`, so the guard cannot live where the
 * arithmetic does. Every caller has to answer the question instead.
 */

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
    sourceType,
    category,
    parentCategory,
    date: new Date(`${month}-15T00:00:00Z`),
    amount: amount.toFixed(2),
    label: null,
    counterparty: null,
    metadata: null,
  } as unknown as DataRow;
}

const MONTHS = ['2025-10', '2025-11', '2025-12'];

/** Every row shape a Shopify or Square sync can produce: sales, plus refunds. */
function revenueOnly(source: string): DataRow[] {
  return MONTHS.flatMap((m, i) => [
    row(source, 'Income', 'Online Sales', m, 100_000 + i * 2_000),
    row(source, 'Expenses', 'Refunds', m, 3_000 + i * 50),
  ]);
}

/** The same business with a source that can see what it spends. */
function withRealCosts(source: string): DataRow[] {
  return [
    ...revenueOnly('shopify'),
    ...MONTHS.map((m) => row(source, 'Expenses', 'Rent', m, 60_000)),
  ];
}

describe('computeCashFlow suppresses a cost-blind net', () => {
  it.each(['shopify', 'square'])('reports nothing for a %s-only org', (source) => {
    expect(computeCashFlow(revenueOnly(source))).toEqual([]);
  });

  // The guard has to be about the source, not about the number. Without that
  // distinction the fix would be a threshold, and a genuinely profitable
  // business would be suppressed for being profitable.
  it('still reports a large surplus when a cost-visible source produced it', () => {
    const stats = computeCashFlow([
      ...MONTHS.flatMap((m) => [
        row('quickbooks', 'Income', 'Consulting', m, 100_000),
        row('quickbooks', 'Expenses', 'Rent', m, 4_000),
      ]),
    ]);

    expect(stats).toHaveLength(1);
    expect(stats[0]!.details.direction).toBe('surplus');
  });

  it('reports a figure once a cost-visible source joins the revenue-only one', () => {
    expect(computeCashFlow(withRealCosts('quickbooks'))).toHaveLength(1);
  });

  it.each(['xero', 'plaid', 'csv'])('treats %s as cost-visible', (source) => {
    expect(computeCashFlow(withRealCosts(source))).toHaveLength(1);
  });

  // An unrecognised source reads as cost-visible, which keeps the guard
  // subtractive: it can only suppress what the other guards already allowed,
  // never widen them. Same reasoning as hasCostVisibility's own default.
  it('does not suppress a source it has never heard of', () => {
    expect(computeCashFlow(withRealCosts('paypal'))).toHaveLength(1);
  });
});

describe('the bucket callers have to answer for themselves', () => {
  // A bucket has no sourceType, so these two cannot derive it. The parameter is
  // required rather than defaulted precisely so a new caller cannot inherit a
  // silent "yes" the way the module did before this.
  const buckets = new Map([
    ['2025-10', { revenue: 100_000, expenses: 3_000 }],
    ['2025-11', { revenue: 102_000, expenses: 3_050 }],
    ['2025-12', { revenue: 104_000, expenses: 3_100 }],
  ]);

  it('cashFlowFromBuckets reports nothing when told the source is cost-blind', () => {
    expect(cashFlowFromBuckets(buckets, false)).toEqual([]);
  });

  it('cashFlowFromBuckets reports a figure when told it is cost-visible', () => {
    expect(cashFlowFromBuckets(buckets, true)).toHaveLength(1);
  });

  // An alert is worse than a dashboard number here, not better: it arrives
  // unprompted and carries its own AI paragraph (DW-7 notes a fired result
  // reaches the alert email). A cost-blind burn spike is a false alarm.
  it('cashFlowForAlerting reports nothing when the source is cost-blind', () => {
    expect(cashFlowForAlerting(buckets, false)).toEqual([]);
  });

  it('cashFlowForAlerting keeps its near-zero band off when cost-visible', () => {
    const flat = new Map([
      ['2025-10', { revenue: 100_000, expenses: 100_100 }],
      ['2025-11', { revenue: 100_000, expenses: 100_050 }],
      ['2025-12', { revenue: 100_000, expenses: 100_080 }],
    ]);
    // cashFlowFromBuckets suppresses this as near-zero; alerting must not.
    expect(cashFlowFromBuckets(flat, true)).toEqual([]);
    expect(cashFlowForAlerting(flat, true)).toHaveLength(1);
  });
});

/** The same business actually losing money, which is what runway needs. */
function burning(source: string): DataRow[] {
  return MONTHS.flatMap((m) => [
    row(source, 'Income', 'Consulting', m, 100_000),
    row(source, 'Expenses', 'Rent', m, 120_000),
  ]);
}

describe('what the guard cascades to, and what it never had to', () => {
  const financials = {
    cashOnHand: 500_000,
    cashAsOfDate: '2025-12-20',
    monthlyFixedCosts: 50_000,
  };
  const now = new Date('2025-12-28T00:00:00Z');
  const nets = { months: MONTHS, nets: [97_000, 98_950, 100_900] };

  // cash_forecast gates on cashFlowStats being non-empty, so this guard covers
  // it for free. Pinned rather than assumed: a refactor giving the forecast its
  // own cash-flow computation would reopen the hole silently.
  it('cash_forecast reports nothing for a revenue-only org', () => {
    expect(
      computeCashForecast(computeCashFlow(revenueOnly('shopify')), financials, nets, now),
    ).toEqual([]);
  });

  /**
   * Runway was never exposed to this, and the reason is worth keeping.
   *
   * It gates on `direction === 'burning'`, and a cost-blind net cannot be
   * negative: the only `Expenses` rows a revenue-only connector writes are
   * refunds, which are a fraction of sales by construction, so the net is
   * always a surplus. The direction guard got there before any cost-visibility
   * guard could.
   *
   * This started as a test asserting runway suppresses for a revenue-only org,
   * which passed before the fix existed. It was passing on the surplus, not on
   * the thing it claimed to check, so it would have gone on passing if the
   * cascade had never worked.
   */
  it('runway was already unreachable, because a cost-blind net is a surplus', () => {
    const [stat] = computeCashFlow([
      ...revenueOnly('shopify'),
      ...MONTHS.map((m) => row('quickbooks', 'Expenses', 'Rent', m, 4_000)),
    ]);

    expect(stat!.details.direction).toBe('surplus');
    expect(computeRunway([stat!], financials, now)).toEqual([]);
  });

  it('runway still fires for a business that is genuinely burning', () => {
    const cashFlow = computeCashFlow(burning('quickbooks'));

    expect(cashFlow[0]!.details.direction).toBe('burning');
    expect(computeRunway(cashFlow, financials, now)).toHaveLength(1);
  });

  // The case the guard does change for runway: a burning business whose losses
  // are only visible through a cost-blind source cannot exist, but a mixed org
  // can, and it has to keep working.
  it('runway fires for a burning org whose costs come from a second source', () => {
    const cashFlow = computeCashFlow([
      ...MONTHS.map((m) => row('shopify', 'Income', 'Online Sales', m, 100_000)),
      ...MONTHS.map((m) => row('quickbooks', 'Expenses', 'Rent', m, 130_000)),
    ]);

    expect(cashFlow).toHaveLength(1);
    expect(computeRunway(cashFlow, financials, now)).toHaveLength(1);
  });
});
