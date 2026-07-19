import { describe, it, expect } from 'vitest';

import { buildStatDetail } from './statDetail.js';
import { computeStats, assignIds } from './computation.js';
import { usd, usdSigned, usdMinus } from './assembly.js';
import type { IdentifiedStat } from './types.js';
import { StatType } from './types.js';

// One real-pipeline dataset that trips all 12 StatTypes at once, run through
// the actual computeStats/assignIds pipeline (not hand-built ComputedStat
// objects), matching the fixture style index.test.ts and statId.test.ts use.
//
// 'Revenue' (Income) and 'COGS' (Expenses) carry two years of monthly data:
// flat in 2025, a step-up in 2026, and a burn in the last 3 months (Oct-Dec
// 2026) to trigger CashFlow/Runway/BreakEven/CashForecast. 'OfficeSupplies'
// (no parentCategory) is a small, separate series so its Trend/Anomaly
// signal doesn't get muddied by the financial-category arithmetic above.
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
  // Oct-Dec 2026: revenue holds, expenses spike, the trailing burn window.
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

// Generic over the specific StatType literal so each call site gets its
// details narrowed (e.g. findStat(StatType.Runway, ...) returns a stat whose
// `.details.cashOnHand` type-checks), instead of the full IdentifiedStat union.
function findStat<T extends StatType>(
  statType: T,
  predicate?: (s: Extract<IdentifiedStat, { statType: T }>) => boolean,
): Extract<IdentifiedStat, { statType: T }> {
  const found = identified.find((s): s is Extract<IdentifiedStat, { statType: T }> => {
    if (s.statType !== statType) return false;
    return !predicate || predicate(s as Extract<IdentifiedStat, { statType: T }>);
  });
  if (!found) throw new Error(`fixture did not produce a ${statType} stat`);
  return found;
}

describe('buildStatDetail', () => {
  it('total: formula-kind, transaction count and total value trace to details.count/value', () => {
    const stat = findStat(StatType.Total, (s) => s.category === 'OfficeSupplies' && s.details.scope === 'category');
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(String(stat.details.count));
    expect(detail.expression).toContain(`$${usd.format(stat.value)}`);
  });

  it('average: formula-kind, average and median trace to stat.value/details.median', () => {
    const stat = findStat(StatType.Average, (s) => s.category === 'OfficeSupplies' && s.details.scope === 'category');
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(`$${stat.value.toFixed(2)}`);
    expect(detail.expression).toContain(`$${stat.details.median.toFixed(2)}`);
  });

  it('cash_flow: formula-kind, median expression traces to each recentMonths net and details.monthlyNet', () => {
    const stat = findStat(StatType.CashFlow);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    for (const month of stat.details.recentMonths) {
      expect(detail.expression).toContain(usdSigned(month.net));
    }
    expect(detail.expression).toContain(usdSigned(stat.details.monthlyNet));
  });

  it('runway: formula-kind, expression contains cashOnHand/monthlyNet/runwayMonths formatted like formatStatBody', () => {
    const stat = findStat(StatType.Runway);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(`$${usd.format(stat.details.cashOnHand)}`);
    expect(detail.expression).toContain(usdSigned(stat.details.monthlyNet));
    expect(detail.expression).toContain(`${stat.details.runwayMonths.toFixed(1)} months`);
  });

  it('break_even: formula-kind, golden-example shape, every figure traces to details', () => {
    const stat = findStat(StatType.BreakEven);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toBe(
      `$${usd.format(stat.details.monthlyFixedCosts)} / (${stat.details.marginPercent.toFixed(1)}% / 100) = $${usd.format(stat.details.breakEvenRevenue)}`,
    );
    expect(detail.terms).toContainEqual({
      label: 'Current revenue',
      value: `$${usd.format(stat.details.currentMonthlyRevenue)}`,
    });
    expect(detail.terms).toContainEqual({ label: 'Gap to break-even', value: usdMinus(stat.details.gap) });
  });

  it('year_over_year: formula-kind, current/prior year values trace to details', () => {
    const stat = findStat(StatType.YearOverYear);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(`$${usd.format(stat.details.currentYear)}`);
    expect(detail.expression).toContain(`$${usd.format(stat.details.priorYear)}`);
  });

  it('margin_trend: formula-kind, recent/prior margin percentages trace to details', () => {
    const stat = findStat(StatType.MarginTrend);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(`${stat.details.recentMarginPercent.toFixed(1)}%`);
    expect(detail.expression).toContain(`${stat.details.priorMarginPercent.toFixed(1)}%`);
    expect(detail.expression).toContain(stat.details.direction);
  });

  it('category_breakdown: formula-kind, absoluteTotal and percentage trace to details', () => {
    const stat = findStat(StatType.CategoryBreakdown, (s) => s.category === 'OfficeSupplies');
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('formula');
    if (detail.kind !== 'formula') return;
    expect(detail.expression).toContain(`$${usd.format(stat.details.absoluteTotal)}`);
    expect(detail.expression).toContain(`${stat.details.percentage.toFixed(1)}%`);
    expect(detail.terms).toContainEqual({ label: 'Transactions', value: String(stat.details.transactionCount) });
  });

  it('trend: inputs-kind, no expression field, method name names no closed-form equation', () => {
    const stat = findStat(StatType.Trend, (s) => s.category === 'OfficeSupplies');
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('inputs');
    if (detail.kind !== 'inputs') return;
    expect(detail).not.toHaveProperty('expression');
    expect(detail.methodName).toBe('Linear regression over the trailing data points');
    expect(detail.inputs).toContainEqual({ label: 'Data points', value: String(stat.details.dataPoints) });
  });

  it('anomaly: inputs-kind, methodName is the fixed Z-score/IQR string, z-score traces to details', () => {
    const stat = findStat(StatType.Anomaly, (s) => s.category === 'OfficeSupplies');
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('inputs');
    if (detail.kind !== 'inputs') return;
    expect(detail).not.toHaveProperty('expression');
    expect(detail.methodName).toBe('Z-score vs category baseline (IQR outlier detection)');
    expect(detail.inputs).toContainEqual({ label: 'Z-score', value: stat.details.zScore.toFixed(2) });
  });

  it('seasonal_projection: inputs-kind, basis months and projected amount trace to details', () => {
    const stat = findStat(StatType.SeasonalProjection);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('inputs');
    if (detail.kind !== 'inputs') return;
    expect(detail).not.toHaveProperty('expression');
    expect(detail.inputs).toContainEqual({ label: 'Basis months', value: stat.details.basisMonths.join(', ') });
    expect(detail.inputs).toContainEqual({ label: 'Confidence', value: stat.details.confidence });
    // the reconciling dollar figure the epic's "render value plus..." contract requires
    expect(detail.inputs).toContainEqual({
      label: 'Projected amount',
      value: `$${Math.round(stat.details.projectedAmount).toLocaleString('en-US')}`,
    });
  });

  it('cash_forecast: inputs-kind, methodName reads details.method verbatim per the golden example', () => {
    const stat = findStat(StatType.CashForecast);
    const detail = buildStatDetail(stat);

    expect(detail.kind).toBe('inputs');
    if (detail.kind !== 'inputs') return;
    expect(detail).not.toHaveProperty('expression');
    expect(detail.methodName).toBe(
      stat.details.method === 'linear_regression'
        ? 'Linear regression on trailing monthly net'
        : 'Rolling mean of trailing monthly net',
    );
    expect(detail.inputs).toContainEqual({ label: 'Confidence', value: stat.details.confidence });

    const finalMonth = stat.details.projectedMonths[stat.details.projectedMonths.length - 1]!;
    const signed = (n: number) => (n >= 0 ? `$${Math.round(n).toLocaleString('en-US')}` : `-$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);
    // the final balance is this stat's own `value`, both must agree with the fixture's projection
    expect(finalMonth.projectedBalance).toBe(stat.value);
    expect(detail.inputs).toContainEqual({ label: 'Starting balance', value: signed(stat.details.startingBalance) });
    expect(detail.inputs).toContainEqual({ label: 'Projected balance (3mo)', value: signed(finalMonth.projectedBalance) });
    expect(detail.inputs).toContainEqual({
      label: 'Crosses zero at month',
      value: stat.details.crossesZeroAtMonth != null ? String(stat.details.crossesZeroAtMonth) : 'not projected',
    });
  });
});
