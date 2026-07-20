import { describe, it, expect } from 'vitest';

import type { MonthlyBucketMap } from '../../services/curation/computation.js';
import { detectFirstTimeMilestones } from './firstTimeMilestones.js';

const NOW = new Date('2026-06-15T00:00:00');

function buckets(entries: Record<string, { revenue: number; expenses: number }>): MonthlyBucketMap {
  return new Map(Object.entries(entries));
}

const NO_AWARDS: ReadonlySet<string> = new Set();

describe('detectFirstTimeMilestones', () => {
  it('fires first_profitable_month when the last completed month is the first-ever profitable one', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-04': { revenue: 4000, expenses: 5000 },
        '2026-05': { revenue: 6000, expenses: 5500 },
      }),
      null,
      NOW,
      NO_AWARDS,
    );
    expect(result).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
    ]);
  });

  it('does not re-fire an already-awarded kind', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-04': { revenue: 4000, expenses: 5000 },
        '2026-05': { revenue: 6000, expenses: 5500 },
      }),
      null,
      NOW,
      new Set(['first_profitable_month']),
    );
    expect(result).toEqual([]);
  });

  it('does not fire a stale historical first, months before the last completed month', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-01': { revenue: 5000, expenses: 4000 },
        '2026-02': { revenue: 4000, expenses: 5000 },
        '2026-03': { revenue: 4000, expenses: 5000 },
        '2026-04': { revenue: 4000, expenses: 5000 },
        '2026-05': { revenue: 4000, expenses: 5000 },
      }),
      null,
      NOW,
      NO_AWARDS,
    );
    expect(result).toEqual([]);
  });

  it('never evaluates first_break_even when monthlyFixedCosts is null, undefined, or zero', () => {
    const monthly = buckets({ '2026-05': { revenue: 8000, expenses: 6000 } });
    expect(detectFirstTimeMilestones(monthly, null, NOW, NO_AWARDS)).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
    ]);
    expect(detectFirstTimeMilestones(monthly, undefined, NOW, NO_AWARDS)).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
    ]);
    expect(detectFirstTimeMilestones(monthly, 0, NOW, NO_AWARDS)).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
    ]);
  });

  it('excludes the in-progress current calendar month even when it looks profitable', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-05': { revenue: 4000, expenses: 5000 },
        '2026-06': { revenue: 9000, expenses: 1000 },
      }),
      null,
      NOW,
      NO_AWARDS,
    );
    expect(result).toEqual([]);
  });

  it('counts a data gap month as absent, not a streak-breaker', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-01': { revenue: 5000, expenses: 4000 },
        '2026-02': { revenue: 5000, expenses: 4000 },
        // 2026-03 has no rows at all, no key in the map
        '2026-04': { revenue: 5000, expenses: 4000 },
      }),
      null,
      new Date('2026-05-01T00:00:00Z'),
      NO_AWARDS,
    );
    expect(result).toContainEqual({
      kind: 'first_three_profitable_streak',
      label: "You've had three profitable months in a row for the first time.",
      statType: null,
    });
  });

  it('fires first_break_even and first_three_profitable_streak together on the same closing month', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-02': { revenue: 8000, expenses: 3000 },
        '2026-03': { revenue: 8500, expenses: 3000 },
        '2026-04': { revenue: 9200, expenses: 3000 },
      }),
      9000,
      new Date('2026-05-01T00:00:00Z'),
      NO_AWARDS,
    );
    expect(result).toEqual([
      {
        kind: 'first_break_even',
        label: 'For the first time, revenue covered your fixed costs.',
        statType: 'break_even',
      },
      {
        kind: 'first_three_profitable_streak',
        label: "You've had three profitable months in a row for the first time.",
        statType: null,
      },
    ]);
  });

  it('fires first_profitable_month and first_break_even together, profitable-month first', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-04': { revenue: 4000, expenses: 5000 },
        '2026-05': { revenue: 6000, expenses: 5000 },
      }),
      4500,
      new Date('2026-06-01T00:00:00Z'),
      NO_AWARDS,
    );
    expect(result).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
      { kind: 'first_break_even', label: 'For the first time, revenue covered your fixed costs.', statType: 'break_even' },
    ]);
  });

  it('never fires the streak kind when the org has fewer than 3 completed months total', () => {
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-04': { revenue: 5000, expenses: 4000 },
        '2026-05': { revenue: 5000, expenses: 4000 },
      }),
      null,
      NOW,
      NO_AWARDS,
    );
    expect(result.map((m) => m.kind)).not.toContain('first_three_profitable_streak');
  });

  it('returns [] when there is no completed month at all', () => {
    const result = detectFirstTimeMilestones(
      buckets({ '2026-06': { revenue: 5000, expenses: 4000 } }),
      null,
      NOW,
      NO_AWARDS,
    );
    expect(result).toEqual([]);
  });

  it('returns [] for a fully empty bucket map', () => {
    expect(detectFirstTimeMilestones(buckets({}), 5000, NOW, NO_AWARDS)).toEqual([]);
  });

  it('anchors the current-month boundary to UTC regardless of process local timezone', () => {
    // 02:00 UTC on the 1st is still 2026-06-30 in any UTC-3 or further-behind zone;
    // monthKey must read 2026-07 off getUTCMonth(), not the local calendar day.
    const now = new Date('2026-07-01T02:00:00Z');
    const result = detectFirstTimeMilestones(
      buckets({
        '2026-05': { revenue: 4000, expenses: 5000 },
        '2026-06': { revenue: 6000, expenses: 5500 },
      }),
      null,
      now,
      NO_AWARDS,
    );
    expect(result).toEqual([
      { kind: 'first_profitable_month', label: 'This is your first profitable month.', statType: null },
    ]);
  });
});
