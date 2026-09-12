import type { ComputedStat } from '../../services/curation/types.js';

// Exported so Story 11.4's milestone detector shares these boundaries instead of re-hardcoding them.
export const SIGNIFICANT_RUNWAY_DELTA_MONTHS = 0.2; // runwayMonths change ≥ this is worth narrating
export const SIGNIFICANT_MARGIN_DELTA_PP = 0.5; // recentMarginPercent change ≥ this is worth narrating
export const SIGNIFICANT_BURN_DELTA_PERCENT = 5; // relative change vs prior monthlyNet, ≥ this is worth narrating
// Absolute floor, checked alongside the percent above. Percent on its own is
// unbounded at a small base: $1 to $3 is a 200% move and two dollars. The number
// that governs behaviour is the crossover, F / 0.05, below which the percent is
// inert and this decides alone. At 100 that is a $2,000 monthly net, which keeps
// the percent live across the range real customers sit in. Higher floors read as
// tidier and cost more than they look: at 500 the crossover is $10,000 and a
// business improving from $2,000 to $2,400 a month gets no line at all, which is
// the digest failing at the only thing it is for. A missed real move is a worse
// failure here than a marginal one that gets skimmed. A burn to surplus sign
// flip no longer qualifies on its own either, since a flip of a few dollars is
// the same noise.
export const SIGNIFICANT_BURN_DELTA_USD = 100;

export interface PriorContextEntry {
  statType: ComputedStat['statType'];
  kind: 'delta' | 'first_tracked';
  text: string;
}

const usd = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usdSigned = (n: number) => `${n >= 0 ? '+' : '-'}$${usd.format(Math.abs(n))}`;

// Diffs this week's curated stats against last week's `digest_history.key_stats`
// snapshot. Pure: no I/O, reads only its two array parameters. `key_stats` only
// ever holds the top-N scored stats, so "present last week, absent this week"
// can't distinguish a genuinely gone signal from one that scored below the
// cutoff — the 2026-06-27 "honest v1" resolution suppresses that disappear line
// entirely rather than print an unprovable claim. The appear case stays, since a
// stat's first appearance is provable even under top-N truncation.
// Detail fields are assumed finite, same as valence.ts: computation.ts only ever
// emits finite numbers, so no NaN/Infinity guard is needed here.
export function buildPriorContext(
  currentStats: readonly ComputedStat[],
  priorStats: readonly ComputedStat[],
): PriorContextEntry[] {
  const entries: PriorContextEntry[] = [];

  // Each `.find` narrows to the matching member via TS 5.5+ inferred type
  // predicates, same as valence.ts. All four HIGH_IMPORTANCE types are
  // null-category and singleton per org, so matching by statType alone is safe.
  const currentRunway = currentStats.find((s) => s.statType === 'runway');
  const priorRunway = priorStats.find((s) => s.statType === 'runway');

  if (currentRunway && !priorRunway) {
    entries.push({
      statType: 'runway',
      kind: 'first_tracked',
      text: `Runway is being tracked for the first time this week, at ${currentRunway.details.runwayMonths.toFixed(1)} months.`,
    });
  } else if (currentRunway && priorRunway) {
    const delta = currentRunway.details.runwayMonths - priorRunway.details.runwayMonths;
    if (Math.abs(delta) >= SIGNIFICANT_RUNWAY_DELTA_MONTHS) {
      entries.push({
        statType: 'runway',
        kind: 'delta',
        text: `Runway moved from ${priorRunway.details.runwayMonths.toFixed(1)} to ${currentRunway.details.runwayMonths.toFixed(1)} months.`,
      });
    }
  }

  // break_even has no defined threshold for a present-both-weeks gap change
  // (Design Notes), so it only ever gets the appear-case first_tracked entry.
  const currentBreakEven = currentStats.find((s) => s.statType === 'break_even');
  const priorBreakEven = priorStats.find((s) => s.statType === 'break_even');

  if (currentBreakEven && !priorBreakEven) {
    const { gap } = currentBreakEven.details;
    const gapText = gap > 0 ? `${usd.format(gap)} short of covering costs` : `${usd.format(Math.abs(gap))} above covering costs`;
    entries.push({
      statType: 'break_even',
      kind: 'first_tracked',
      text: `Break-even is being tracked for the first time this week: revenue is ${gapText}.`,
    });
  }

  const currentCashFlow = currentStats.find((s) => s.statType === 'cash_flow');
  const priorCashFlow = priorStats.find((s) => s.statType === 'cash_flow');

  if (currentCashFlow && !priorCashFlow) {
    entries.push({
      statType: 'cash_flow',
      kind: 'first_tracked',
      text: `Cash flow is being tracked for the first time this week, at ${usdSigned(currentCashFlow.details.monthlyNet)}/mo.`,
    });
  } else if (currentCashFlow && priorCashFlow) {
    const priorNet = priorCashFlow.details.monthlyNet;
    const currentNet = currentCashFlow.details.monthlyNet;
    const absDelta = Math.abs(currentNet - priorNet);
    // Both gates have to clear. Percent change is also undefined at a zero base,
    // so a move off zero skips the percent and leans on the dollar floor alone;
    // zero to zero stays flat because the floor rejects a delta of nothing.
    const isSignificant =
      absDelta >= SIGNIFICANT_BURN_DELTA_USD &&
      (priorNet === 0 || (absDelta / Math.abs(priorNet)) * 100 >= SIGNIFICANT_BURN_DELTA_PERCENT);

    if (isSignificant) {
      entries.push({
        statType: 'cash_flow',
        kind: 'delta',
        text: `Monthly cash flow moved from ${usdSigned(priorNet)} to ${usdSigned(currentNet)}.`,
      });
    }
  }

  const currentMargin = currentStats.find((s) => s.statType === 'margin_trend');
  const priorMargin = priorStats.find((s) => s.statType === 'margin_trend');

  if (currentMargin && !priorMargin) {
    entries.push({
      statType: 'margin_trend',
      kind: 'first_tracked',
      text: `Margin is being tracked for the first time this week, at ${currentMargin.details.recentMarginPercent.toFixed(1)}%.`,
    });
  } else if (currentMargin && priorMargin) {
    const delta = currentMargin.details.recentMarginPercent - priorMargin.details.recentMarginPercent;
    if (Math.abs(delta) >= SIGNIFICANT_MARGIN_DELTA_PP) {
      entries.push({
        statType: 'margin_trend',
        kind: 'delta',
        text: `Margin moved from ${priorMargin.details.recentMarginPercent.toFixed(1)}% to ${currentMargin.details.recentMarginPercent.toFixed(1)}%.`,
      });
    }
  }

  return entries;
}
