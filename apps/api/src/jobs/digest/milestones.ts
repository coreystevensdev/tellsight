import type { ComputedStat } from '../../services/curation/types.js';
import { RUNWAY_CONCERNING_THRESHOLD, RUNWAY_POSITIVE_THRESHOLD } from './valence.js';

export type MilestoneKind =
  | 'turned_cash_positive'
  | 'turned_cash_negative'
  | 'crossed_break_even'
  | 'runway_extended_past_6mo'
  | 'runway_dropped_below_3mo'
  | 'margin_turned_expanding'
  | 'forecast_crosses_zero';

export interface TransitionMilestone {
  kind: MilestoneKind;
  label: string;
  statType: ComputedStat['statType'];
}

// Diffs this week's curated stats against last week's `digest_history.key_stats`
// snapshot looking for the 7-row launch catalog of trajectory crossings. Pure:
// no I/O, reads only its two array parameters. A milestone requires the stat
// present both weeks, same absence rule as buildPriorContext.ts, since a
// crossing can't be asserted without both endpoints.
export function detectTransitionMilestones(
  currentStats: readonly ComputedStat[],
  priorStats: readonly ComputedStat[],
): TransitionMilestone[] {
  const milestones: TransitionMilestone[] = [];

  const currentCashFlow = currentStats.find((s) => s.statType === 'cash_flow');
  const priorCashFlow = priorStats.find((s) => s.statType === 'cash_flow');
  if (currentCashFlow && priorCashFlow) {
    if (priorCashFlow.details.direction === 'burning' && currentCashFlow.details.direction === 'surplus') {
      milestones.push({
        kind: 'turned_cash_positive',
        label: 'You turned cash-flow positive.',
        statType: 'cash_flow',
      });
    } else if (priorCashFlow.details.direction === 'surplus' && currentCashFlow.details.direction === 'burning') {
      milestones.push({
        kind: 'turned_cash_negative',
        label: 'You started burning cash this month.',
        statType: 'cash_flow',
      });
    }
  }

  const currentBreakEven = currentStats.find((s) => s.statType === 'break_even');
  const priorBreakEven = priorStats.find((s) => s.statType === 'break_even');
  if (currentBreakEven && priorBreakEven && priorBreakEven.details.gap > 0 && currentBreakEven.details.gap <= 0) {
    milestones.push({
      kind: 'crossed_break_even',
      label: 'Revenue now covers your fixed costs.',
      statType: 'break_even',
    });
  }

  const currentRunway = currentStats.find((s) => s.statType === 'runway');
  const priorRunway = priorStats.find((s) => s.statType === 'runway');
  if (currentRunway && priorRunway) {
    if (
      priorRunway.details.runwayMonths < RUNWAY_POSITIVE_THRESHOLD &&
      currentRunway.details.runwayMonths >= RUNWAY_POSITIVE_THRESHOLD
    ) {
      milestones.push({
        kind: 'runway_extended_past_6mo',
        label: 'Your runway extended past 6 months.',
        statType: 'runway',
      });
    }
    if (
      priorRunway.details.runwayMonths >= RUNWAY_CONCERNING_THRESHOLD &&
      currentRunway.details.runwayMonths < RUNWAY_CONCERNING_THRESHOLD
    ) {
      milestones.push({
        kind: 'runway_dropped_below_3mo',
        label: 'Your runway dropped below 3 months.',
        statType: 'runway',
      });
    }
  }

  const currentMargin = currentStats.find((s) => s.statType === 'margin_trend');
  const priorMargin = priorStats.find((s) => s.statType === 'margin_trend');
  if (
    currentMargin &&
    priorMargin &&
    priorMargin.details.direction === 'shrinking' &&
    currentMargin.details.direction === 'expanding'
  ) {
    milestones.push({
      kind: 'margin_turned_expanding',
      label: 'Your margin started expanding.',
      statType: 'margin_trend',
    });
  }

  const currentForecast = currentStats.find((s) => s.statType === 'cash_forecast');
  const priorForecast = priorStats.find((s) => s.statType === 'cash_forecast');
  if (
    currentForecast &&
    priorForecast &&
    priorForecast.details.crossesZeroAtMonth === null &&
    currentForecast.details.crossesZeroAtMonth !== null
  ) {
    const month = currentForecast.details.crossesZeroAtMonth;
    milestones.push({
      kind: 'forecast_crosses_zero',
      label: `Your forecast now dips below zero within ${month} month${month === 1 ? '' : 's'}.`,
      statType: 'cash_forecast',
    });
  }

  return milestones;
}
