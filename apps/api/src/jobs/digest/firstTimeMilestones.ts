import type { MonthlyBucketMap } from '../../services/curation/computation.js';
import type { DigestMilestoneEntry } from './milestones.js';

export type FirstTimeMilestoneKind =
  | 'first_profitable_month'
  | 'first_break_even'
  | 'first_three_profitable_streak';

export interface FirstTimeMilestone extends DigestMilestoneEntry {
  kind: FirstTimeMilestoneKind;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Reads the org's full monthly history (never digest_history, which only
// covers recent weeks) looking for the three launch-catalog all-time firsts.
// Pure: no I/O, no database, awardedKinds is the caller's job to fetch so
// this stays testable with plain objects.
//
// A milestone only fires when its first-ever occurrence lands in the most
// recently completed month, otherwise a run months after the actual first
// would keep re-surfacing stale history. The in-progress current calendar
// month is excluded up front so a partial month never counts.
export function detectFirstTimeMilestones(
  buckets: MonthlyBucketMap,
  monthlyFixedCosts: number | null | undefined,
  now: Date,
  awardedKinds: ReadonlySet<string>,
): FirstTimeMilestone[] {
  const currentMonthKey = monthKey(now);
  const months = [...buckets.keys()].filter((m) => m < currentMonthKey).sort();
  if (months.length === 0) return [];

  const lastIdx = months.length - 1;
  const checkBreakEven = typeof monthlyFixedCosts === 'number' && monthlyFixedCosts > 0;

  let firstProfitableIdx = -1;
  let firstBreakEvenIdx = -1;
  let firstStreakIdx = -1;
  let streak = 0;

  months.forEach((key, idx) => {
    const bucket = buckets.get(key)!;
    const isProfitable = bucket.revenue - bucket.expenses > 0;

    if (isProfitable && firstProfitableIdx === -1) firstProfitableIdx = idx;

    if (checkBreakEven && firstBreakEvenIdx === -1 && bucket.revenue >= monthlyFixedCosts) {
      firstBreakEvenIdx = idx;
    }

    streak = isProfitable ? streak + 1 : 0;
    if (streak >= 3 && firstStreakIdx === -1) firstStreakIdx = idx;
  });

  const milestones: FirstTimeMilestone[] = [];

  if (firstProfitableIdx === lastIdx && !awardedKinds.has('first_profitable_month')) {
    milestones.push({
      kind: 'first_profitable_month',
      label: 'This is your first profitable month.',
      statType: null,
    });
  }

  if (firstBreakEvenIdx === lastIdx && !awardedKinds.has('first_break_even')) {
    milestones.push({
      kind: 'first_break_even',
      label: 'For the first time, revenue covered your fixed costs.',
      statType: 'break_even',
    });
  }

  if (firstStreakIdx === lastIdx && !awardedKinds.has('first_three_profitable_streak')) {
    milestones.push({
      kind: 'first_three_profitable_streak',
      label: "You've had three profitable months in a row for the first time.",
      statType: null,
    });
  }

  return milestones;
}
