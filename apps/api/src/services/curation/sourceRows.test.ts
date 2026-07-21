import { describe, it, expect } from 'vitest';

import { resolveSourceRows } from './sourceRows.js';
import { computeStats, assignIds, computeCashFlow, marginTrendMonths, monthKey } from './computation.js';
import type { IdentifiedStat } from './types.js';
import { StatType } from './types.js';

// Same fixture shape as statDetail.test.ts, run through the real
// computeStats/assignIds pipeline so every assertion traces to an actual
// computed value, not a hand-built ComputedStat. Two years of Revenue/COGS
// (flat 2025, step-up 2026, a burn in the last 3 months) trips
// CashFlow/Runway/BreakEven/CashForecast/MarginTrend; OfficeSupplies is a
// standalone category (no parentCategory) that must never leak into any of
// those financial-window results.
let _rowId = 1;
function row(category: string, parentCategory: string | null, date: Date, amount: number) {
  return {
    id: _rowId++,
    orgId: 1,
    datasetId: 1,
    sourceType: 'csv' as const,
    category,
    parentCategory,
    date,
    amount: amount.toFixed(2),
    label: null,
    metadata: null,
    createdAt: new Date(),
  };
}

function buildFixtureRows() {
  const rows = [];

  for (let m = 0; m < 12; m++) {
    rows.push(row('Revenue', 'Income', new Date(2025, m, 15), 8000));
    rows.push(row('COGS', 'Expenses', new Date(2025, m, 15), 6000));
  }
  for (let m = 0; m < 9; m++) {
    rows.push(row('Revenue', 'Income', new Date(2026, m, 15), 8800));
    rows.push(row('COGS', 'Expenses', new Date(2026, m, 15), 6000));
  }
  for (let m = 9; m < 12; m++) {
    rows.push(row('Revenue', 'Income', new Date(2026, m, 15), 8800));
    rows.push(row('COGS', 'Expenses', new Date(2026, m, 15), 10500));
  }

  const officeSupplies = [100, 105, 98, 102, 500];
  officeSupplies.forEach((amount, i) => {
    rows.push(row('OfficeSupplies', null, new Date(2026, i, 5), amount));
  });

  return rows;
}

const fixtureRows = buildFixtureRows();
const NOW = new Date('2027-01-15T00:00:00Z');
const stats = computeStats(fixtureRows, {
  financials: { cashOnHand: 20_000, cashAsOfDate: '2027-01-05T00:00:00Z', monthlyFixedCosts: 5_000 },
  now: NOW,
});
const identified = assignIds(stats, 1);

function findStat<T extends StatType>(
  statType: T,
  predicate?: (s: Extract<IdentifiedStat, { statType: T }>) => boolean,
  source: IdentifiedStat[] = identified,
): Extract<IdentifiedStat, { statType: T }> {
  const found = source.find((s): s is Extract<IdentifiedStat, { statType: T }> => {
    if (s.statType !== statType) return false;
    return !predicate || predicate(s as Extract<IdentifiedStat, { statType: T }>);
  });
  if (!found) throw new Error(`fixture did not produce a ${statType} stat`);
  return found;
}

describe('resolveSourceRows', () => {
  it('total: category scope returns only that category, overall scope returns every row', () => {
    const catStat = findStat(StatType.Total, (s) => s.category === 'OfficeSupplies' && s.details.scope === 'category');
    const catRows = resolveSourceRows(fixtureRows, catStat);
    expect(catRows.length).toBe(5);
    expect(catRows.every((r) => r.category === 'OfficeSupplies')).toBe(true);

    const overallStat = findStat(StatType.Total, (s) => s.category === null);
    const overallRows = resolveSourceRows(fixtureRows, overallStat);
    expect(overallRows.length).toBe(fixtureRows.length);
  });

  it('average: category scope returns only that category\'s rows, matching details.count from the sibling total', () => {
    const stat = findStat(StatType.Average, (s) => s.category === 'OfficeSupplies' && s.details.scope === 'category');
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.category === 'OfficeSupplies')).toBe(true);
  });

  it('trend: returns every row in the trending category, matching details.dataPoints', () => {
    const stat = findStat(StatType.Trend, (s) => s.category === 'OfficeSupplies');
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBe(stat.details.dataPoints);
    expect(rows.every((r) => r.category === 'OfficeSupplies')).toBe(true);
  });

  it('category_breakdown: returns every row in that category, matching details.transactionCount', () => {
    const stat = findStat(StatType.CategoryBreakdown, (s) => s.category === 'OfficeSupplies');
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBe(stat.details.transactionCount);
    expect(rows.every((r) => r.category === 'OfficeSupplies')).toBe(true);
  });

  it('anomaly: returns only the row(s) in-category whose amount equals the flagged value', () => {
    const stat = findStat(StatType.Anomaly, (s) => s.category === 'OfficeSupplies');
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.category === 'OfficeSupplies' && Number(r.amount) === stat.value)).toBe(true);
  });

  it('year_over_year: returns only Income rows in the cited month for the current/prior years', () => {
    const stat = findStat(StatType.YearOverYear);
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.parentCategory).toBe('Income');
      expect([stat.details.currentYearLabel, stat.details.priorYearLabel]).toContain(String(r.date.getFullYear()));
    }
  });

  it('seasonal_projection: returns only Income rows whose MMM YYYY label is a basis month', () => {
    const stat = findStat(StatType.SeasonalProjection);
    const rows = resolveSourceRows(fixtureRows, stat);
    expect(rows.length).toBe(stat.details.basisMonths.length);
    expect(rows.every((r) => r.parentCategory === 'Income')).toBe(true);
  });

  it('cash_flow: returns exactly the rows within the trailing window months, never the full dataset', () => {
    const stat = findStat(StatType.CashFlow);
    const rows = resolveSourceRows(fixtureRows, stat);
    const windowMonths = new Set(stat.details.recentMonths.map((m) => m.month));

    expect(rows.length).toBeLessThan(fixtureRows.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
      expect(['Income', 'Expenses']).toContain(r.parentCategory);
    }
  });

  it('runway: returns exactly the trailing cash-flow window rows from computeCashFlow(rows, 3), never the full dataset', () => {
    const stat = findStat(StatType.Runway);
    const rows = resolveSourceRows(fixtureRows, stat);
    const cashFlow = computeCashFlow(fixtureRows, 3);
    const windowMonths = new Set(cashFlow[0]!.details.recentMonths.map((m) => m.month));

    expect(rows.length).toBeLessThan(fixtureRows.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
      expect(['Income', 'Expenses']).toContain(r.parentCategory);
    }
  });

  it('runway: derives its window from the resolved stat, not a hardcoded 3, when cashFlowWindow is non-default', () => {
    const customStats = computeStats(fixtureRows, {
      financials: { cashOnHand: 20_000, cashAsOfDate: '2027-01-05T00:00:00Z', monthlyFixedCosts: 5_000 },
      now: NOW,
      cashFlowWindow: 2,
    });
    const customIdentified = assignIds(customStats, 1);
    const stat = findStat(StatType.Runway, undefined, customIdentified);
    expect(stat.details.trailingMonths).toBe(2);

    const rows = resolveSourceRows(fixtureRows, stat);
    const windowMonths = new Set(computeCashFlow(fixtureRows, 2)[0]!.details.recentMonths.map((m) => m.month));
    const staleWindowMonths = new Set(computeCashFlow(fixtureRows, 3)[0]!.details.recentMonths.map((m) => m.month));

    expect(windowMonths.size).toBe(2);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
    }
    // The 2-month window is a trailing subset of the 3-month one (not just
    // "different"), and a hardcoded computeCashFlow(rows, 3) would have
    // pulled in the older month the resolved stat's own window never claims.
    expect([...windowMonths].every((m) => staleWindowMonths.has(m))).toBe(true);
    expect([...staleWindowMonths].some((m) => !windowMonths.has(m))).toBe(true);
  });

  it('runway: returns no rows when the resolved stat\'s window exceeds the available months', () => {
    const stat = findStat(StatType.Runway);
    const inflatedStat = { ...stat, details: { ...stat.details, trailingMonths: 1000 } };

    expect(resolveSourceRows(fixtureRows, inflatedStat)).toEqual([]);
  });

  it('break_even: returns only Income/Expenses rows in the combined recent+prior margin-trend window', () => {
    const stat = findStat(StatType.BreakEven);
    const rows = resolveSourceRows(fixtureRows, stat);
    const split = marginTrendMonths(fixtureRows)!;
    const windowMonths = new Set([...split.recentMonths, ...split.priorMonths]);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
      expect(['Income', 'Expenses']).toContain(r.parentCategory);
    }
    // OfficeSupplies shares calendar months with the margin-trend window but
    // never fed the margin calculation, it must never leak into the result.
    expect(rows.some((r) => r.category === 'OfficeSupplies')).toBe(false);
  });

  it('margin_trend: returns only Income/Expenses rows in the combined recent+prior window', () => {
    const stat = findStat(StatType.MarginTrend);
    const rows = resolveSourceRows(fixtureRows, stat);
    const split = marginTrendMonths(fixtureRows)!;
    const windowMonths = new Set([...split.recentMonths, ...split.priorMonths]);

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
      expect(['Income', 'Expenses']).toContain(r.parentCategory);
    }
    expect(rows.some((r) => r.category === 'OfficeSupplies')).toBe(false);
  });

  it('cash_forecast: returns exactly the basis-month rows, never the full dataset', () => {
    const stat = findStat(StatType.CashForecast);
    const rows = resolveSourceRows(fixtureRows, stat);
    const windowMonths = new Set(stat.details.basisMonths);

    expect(rows.length).toBeLessThan(fixtureRows.length);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(windowMonths.has(monthKey(r.date))).toBe(true);
      expect(['Income', 'Expenses']).toContain(r.parentCategory);
    }
  });

  it('does not mutate the stat or the row array it is given', () => {
    const stat = findStat(StatType.CashFlow);
    const detailsSnapshot = JSON.stringify(stat.details);
    const rowsSnapshot = fixtureRows.length;

    resolveSourceRows(fixtureRows, stat);

    expect(JSON.stringify(stat.details)).toBe(detailsSnapshot);
    expect(fixtureRows.length).toBe(rowsSnapshot);
  });
});
