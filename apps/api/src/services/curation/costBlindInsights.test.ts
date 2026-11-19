import { describe, expect, it } from 'vitest';

import { computeStats } from './computation.js';
import {
  COST_BLIND_INSIGHTS,
  costBlindSources,
  hasCostVisibility,
  type DataRow,
} from './computationPrimitives.js';

// The claim DW-279 measured, as a test rather than a paragraph: a revenue-only
// connector produces a confident pile of stats with the interesting half
// missing, and nothing downstream could tell that apart from a quiet week.
//
// The point of running computeStats here rather than asserting the constant
// against itself is drift. COST_BLIND_INSIGHTS is hand-maintained, so a stat
// type added later that needs both sides of the ledger has to fail something,
// or the product goes back to promising an insight the dataset cannot support.

function month(i: number): Date {
  return new Date(Date.UTC(2026, i, 15));
}

/** Twelve months of sales and nothing else, which is all a store can report. */
function revenueOnly(sourceType: string): DataRow[] {
  const rows: DataRow[] = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      sourceType,
      category: 'Sales',
      parentCategory: 'Income',
      date: month(i),
      amount: String(8_000 + i * 250),
      counterparty: null,
      label: null,
    });
    // A refund, which is the only Expenses row a revenue-only connector writes.
    // This is what makes the naive guards insufficient: the expense total is
    // positive, so `priorExpense <= 0` never fires (DW-252/DW-261).
    rows.push({
      sourceType,
      category: 'Refunds',
      parentCategory: 'Expenses',
      date: month(i),
      amount: '180',
      counterparty: null,
      label: null,
    });
  }
  return rows;
}

/** The same shape with real operating costs behind it. */
function withCosts(sourceType: string): DataRow[] {
  const rows = revenueOnly(sourceType);
  for (let i = 0; i < 12; i++) {
    rows.push({
      sourceType,
      category: 'Rent',
      parentCategory: 'Expenses',
      date: month(i),
      amount: '4200',
      counterparty: null,
      label: null,
    });
  }
  return rows;
}

// break_even is solved from margin and needs a fixed-cost figure on top, so a
// probe that omits financials cannot tell "suppressed because the source is
// blind" from "never had the inputs". That is the same conflation DW-279's own
// production table fell into.
function statTypes(rows: DataRow[]): Set<string> {
  const stats = computeStats(rows, {
    trendMinPoints: 3,
    financials: { monthlyFixedCosts: 5_000 },
  });
  return new Set(stats.map((s) => s.statType));
}

describe('COST_BLIND_INSIGHTS matches what a revenue-only dataset actually loses', () => {
  // The guard against the constant drifting away from the pipeline.
  it.each([...COST_BLIND_INSIGHTS])('a shopify-only dataset produces no %s', (statType) => {
    expect(statTypes(revenueOnly('shopify'))).not.toContain(statType);
  });

  it.each([...COST_BLIND_INSIGHTS])('the same dataset with real costs produces %s', (statType) => {
    expect(statTypes(withCosts('quickbooks'))).toContain(statType);
  });

  // The other half of the claim, and the reason this is a silent failure rather
  // than an obvious one: the pipeline does not break, it produces the commodity
  // stats any dashboard already gives you.
  it('still produces the commodity stats, which is why nothing looks wrong', () => {
    const types = statTypes(revenueOnly('shopify'));

    expect(types).toContain('total');
    expect(types).toContain('average');
    expect(types).toContain('category_breakdown');
    expect(types.size).toBeGreaterThan(0);
  });
});

describe('costBlindSources', () => {
  it.each(['shopify', 'square'])('names %s when it is the only source', (source) => {
    expect(costBlindSources(revenueOnly(source))).toEqual([source]);
  });

  it('names every blind source, sorted, so the message can list them', () => {
    expect(costBlindSources([...revenueOnly('shopify'), ...revenueOnly('square')])).toEqual([
      'shopify',
      'square',
    ]);
  });

  // All of them, not any. One accounting row means the costs are visible and
  // there is nothing to warn about, which is the correct answer for the
  // QuickBooks-plus-Shopify org.
  it.each(['csv', 'quickbooks', 'xero', 'plaid'])(
    'reports nothing when %s is also present',
    (source) => {
      expect(costBlindSources([...revenueOnly('shopify'), ...withCosts(source)])).toEqual([]);
    },
  );

  it('reports nothing for a dataset that is already cost-visible', () => {
    expect(costBlindSources(withCosts('quickbooks'))).toEqual([]);
  });

  // Subtractive, like hasCostVisibility: an unrecognised source reads as
  // cost-visible, so a connector added without classifying it cannot be accused
  // of blindness it may not have.
  it('reports nothing for a source it does not recognise', () => {
    expect(costBlindSources([{ sourceType: 'paypal' }])).toEqual([]);
  });

  it('reports nothing when any row carries no source at all', () => {
    expect(costBlindSources([{ sourceType: 'shopify' }, { sourceType: null }])).toEqual([]);
  });

  it('reports nothing for an empty dataset', () => {
    expect(costBlindSources([])).toEqual([]);
  });
});

describe('the two predicates answer different questions', () => {
  // The distinction the fix rests on. Both are false here, for reasons that
  // need opposite advice.
  it('separates a source that cannot see costs from data that has none yet', () => {
    const blindSource = revenueOnly('shopify');
    const emptyButCapable: DataRow[] = [
      {
        sourceType: 'csv',
        category: 'Sales',
        parentCategory: 'Income',
        date: month(0),
        amount: '5000',
        counterparty: null,
        label: null,
      },
    ];

    expect(hasCostVisibility(blindSource)).toBe(false);
    expect(hasCostVisibility(emptyButCapable)).toBe(false);

    // Only one of them is something the owner can act on by changing connector.
    expect(costBlindSources(blindSource)).toEqual(['shopify']);
    expect(costBlindSources(emptyButCapable)).toEqual([]);
  });
});
