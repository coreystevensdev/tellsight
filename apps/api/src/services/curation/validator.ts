import { statTagCapture, statTagGlobal } from 'shared/constants';
import type { ComputedStat } from './types.js';
import { StatType } from './types.js';

export interface UnmatchedNumber {
  raw: string;
  value: number;
  kind: 'currency' | 'percent';
  context: string;
}

export interface ValidationReport {
  status: 'clean' | 'warnings' | 'suspicious';
  unmatchedNumbers: UnmatchedNumber[];
  numbersChecked: number;
  allowedValueCount: number;
}

export interface ValidateOptions {
  tolerancePercent?: number;
  warningThreshold?: number;
  suspiciousThreshold?: number;
}

// suffix negative-lookahead prevents "b" in "but" being read as a billion-suffix
const CURRENCY_RE = /\$\s*([\d,]+(?:\.\d+)?)(?:\s*([kKmMbB])(?![a-zA-Z]))?/g;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s*%/g;
const SUFFIX_MULT: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, b: 1e9, B: 1e9 };

interface AllowedSets {
  currency: number[];
  percent: number[];
}

function parseCurrency(match: RegExpMatchArray): number {
  const base = parseFloat(match[1]!.replace(/,/g, ''));
  const suffix = match[2];
  return suffix ? base * SUFFIX_MULT[suffix]! : base;
}

function contextSnippet(text: string, index: number, radius = 40): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function classifyStatNumbers(stat: ComputedStat, sets: AllowedSets): void {
  const addC = (n: number) => sets.currency.push(n);
  const addP = (n: number) => sets.percent.push(n);

  switch (stat.statType) {
    case StatType.Total:
      addC(stat.value);
      if (stat.comparison !== undefined) addC(stat.comparison);
      return;
    case StatType.Average:
      addC(stat.value);
      addC(stat.details.median);
      if (stat.comparison !== undefined) addC(stat.comparison);
      return;
    case StatType.Trend:
      addC(stat.details.firstValue);
      addC(stat.details.lastValue);
      addP(stat.details.growthPercent);
      addP(Math.abs(stat.details.growthPercent));
      return;
    case StatType.Anomaly:
      addC(stat.value);
      addC(stat.details.iqrBounds.lower);
      addC(stat.details.iqrBounds.upper);
      addC(stat.details.deviation);
      return;
    case StatType.CategoryBreakdown:
      addC(stat.value);
      addC(stat.details.absoluteTotal);
      addC(stat.details.min);
      addC(stat.details.max);
      addP(stat.details.percentage);
      return;
    case StatType.YearOverYear:
      addC(stat.details.currentYear);
      addC(stat.details.priorYear);
      addP(stat.details.changePercent);
      addP(Math.abs(stat.details.changePercent));
      return;
    case StatType.MarginTrend:
      addP(stat.details.recentMarginPercent);
      addP(stat.details.priorMarginPercent);
      addP(stat.details.revenueGrowthPercent);
      addP(stat.details.expenseGrowthPercent);
      addP(Math.abs(stat.details.revenueGrowthPercent));
      addP(Math.abs(stat.details.expenseGrowthPercent));
      return;
    case StatType.SeasonalProjection:
      addC(stat.details.projectedAmount);
      for (const v of stat.details.basisValues) addC(v);
      return;
    case StatType.CashFlow:
      // prose strips the sign — "$4k/mo" not "-$4k/mo"
      addC(Math.abs(stat.details.monthlyNet));
      for (const m of stat.details.recentMonths) {
        addC(m.revenue);
        addC(m.expenses);
        addC(Math.abs(m.net));
      }
      return;
    case StatType.Runway:
      // Currency coverage only — runway months are a plain number in prose
      // ("3 months") and the current scanner is currency/percent. A months-unit
      // scanner is out of scope for this story; runway-months fabrications are
      // an acknowledged coverage gap.
      addC(stat.details.cashOnHand);
      addC(Math.abs(stat.details.monthlyNet));
      return;
    case StatType.BreakEven:
      // breakEvenRevenue, monthlyFixedCosts, currentMonthlyRevenue: the three
      // currency tokens the LLM is expected to quote. `gap` is not pushed
      // separately — it's already expressible as |breakEvenRevenue - currentRevenue|
      // via the pairwise-sum loop below. Pushing it would mask the tolerance
      // check. marginPercent is already covered by MarginTrend classification.
      addC(stat.details.breakEvenRevenue);
      addC(stat.details.monthlyFixedCosts);
      addC(stat.details.currentMonthlyRevenue);
      return;
    case StatType.CashForecast:
      // startingBalance and each projected balance anchor the chart's prose
      // rendering. projectedNet values cover prose like "burning about $10k/mo
      // going forward" — strip sign matching CashFlow's pattern. Negative
      // balances are pushed as absolute values too so "-$12,000" matches on
      // the magnitude via the currency regex.
      addC(stat.details.startingBalance);
      for (const pm of stat.details.projectedMonths) {
        addC(pm.projectedBalance);
        addC(Math.abs(pm.projectedBalance));
        addC(Math.abs(pm.projectedNet));
      }
      // Deliberately NOT pushed: slope, intercept (regression coefficients the
      // LLM should not quote — a fabricated slope is a real hallucination).
      return;
  }
}

function buildAllowedSets(stats: ComputedStat[]): AllowedSets {
  const sets: AllowedSets = { currency: [], percent: [] };
  for (const s of stats) classifyStatNumbers(s, sets);

  // pairwise sums and differences within currency — covers category totals, period gaps.
  // cross-kind pairwise (e.g., percent + count) would create spurious matches like 83+12=95.
  const cur = [...sets.currency];
  const derived = new Set(cur);
  for (let i = 0; i < cur.length; i++) {
    for (let j = i + 1; j < cur.length; j++) {
      derived.add(cur[i]! + cur[j]!);
      derived.add(Math.abs(cur[i]! - cur[j]!));
    }
  }

  // v1.2 counterfactual: non-dominant remainder and monthly run-rates
  for (const s of stats) {
    if (s.statType === StatType.CategoryBreakdown) {
      const { percentage, absoluteTotal } = s.details;
      if (percentage > 0 && percentage < 100) {
        const nonDominant = (absoluteTotal * (100 - percentage)) / 100;
        derived.add(nonDominant);
        derived.add(nonDominant / 12);
        derived.add(absoluteTotal / 12);
      }
    }
  }

  return {
    currency: [...derived],
    percent: [...new Set(sets.percent)],
  };
}

function isAllowed(candidate: number, allowed: number[], tolerancePercent: number): boolean {
  for (const a of allowed) {
    if (a === 0 && candidate === 0) return true;
    if (a === 0) continue;
    const relDiff = (Math.abs(candidate - a) / Math.abs(a)) * 100;
    if (relDiff <= tolerancePercent) return true;
  }
  return false;
}

export function validateSummary(
  summary: string,
  stats: ComputedStat[],
  options: ValidateOptions = {},
): ValidationReport {
  const tolerancePercent = options.tolerancePercent ?? 2;
  const warningThreshold = options.warningThreshold ?? 1;
  const suspiciousThreshold = options.suspiciousThreshold ?? 3;

  const allowed = buildAllowedSets(stats);
  const unmatched: UnmatchedNumber[] = [];
  let numbersChecked = 0;

  for (const match of summary.matchAll(CURRENCY_RE)) {
    const value = parseCurrency(match);
    numbersChecked++;
    if (!isAllowed(value, allowed.currency, tolerancePercent)) {
      unmatched.push({
        raw: match[0],
        value,
        kind: 'currency',
        context: contextSnippet(summary, match.index ?? 0),
      });
    }
  }

  for (const match of summary.matchAll(PERCENT_RE)) {
    const value = parseFloat(match[1]!);
    numbersChecked++;
    if (!isAllowed(value, allowed.percent, tolerancePercent)) {
      unmatched.push({
        raw: match[0],
        value,
        kind: 'percent',
        context: contextSnippet(summary, match.index ?? 0),
      });
    }
  }

  const status: ValidationReport['status'] =
    unmatched.length === 0
      ? 'clean'
      : unmatched.length >= suspiciousThreshold
        ? 'suspicious'
        : unmatched.length >= warningThreshold
          ? 'warnings'
          : 'clean';

  return {
    status,
    unmatchedNumbers: unmatched,
    numbersChecked,
    allowedValueCount: allowed.currency.length + allowed.percent.length,
  };
}

// Tier 2: chart-reference validation. The LLM emits <stat id="..."/> tokens
// to bind paragraphs to charts; we cross-check each emitted ID against the
// stat types the pipeline actually computed. Hallucinated IDs get stripped
// from the cached summary and tracked as analytics so prompt drift is visible.

export interface StatRefReport {
  invalidRefs: string[];
}

export function validateStatRefs(summary: string, stats: ComputedStat[]): StatRefReport {
  const allowed = new Set<string>(stats.map((s) => s.statType));
  const invalid = new Set<string>();
  for (const match of summary.matchAll(statTagCapture())) {
    const id = match[1]!;
    if (!allowed.has(id)) invalid.add(id);
  }
  return { invalidRefs: [...invalid] };
}

// strips only the tags whose IDs appear in invalidRefs. Valid tags survive
// so paragraph→chart binding still works on cache hits.
export function stripInvalidStatRefs(summary: string, invalidRefs: string[]): string {
  if (invalidRefs.length === 0) return summary;
  const ids = new Set(invalidRefs);
  return summary.replace(statTagGlobal(), (full) => {
    const idMatch = full.match(/id="(\w+)"/);
    return idMatch && ids.has(idMatch[1]!) ? '' : full;
  });
}
