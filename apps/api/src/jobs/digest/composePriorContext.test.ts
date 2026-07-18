import { describe, it, expect } from 'vitest';

import type { PriorContextEntry } from './buildPriorContext.js';
import type { TransitionMilestone } from './milestones.js';
import { composePriorContext } from './composePriorContext.js';

const runwayDelta: PriorContextEntry = {
  statType: 'runway',
  kind: 'delta',
  text: 'Runway moved from 4.0 to 3.5 months.',
};

const runwayMilestone: TransitionMilestone = {
  kind: 'runway_dropped_below_3mo',
  label: 'Your runway dropped below 3 months.',
  statType: 'runway',
};

describe('composePriorContext', () => {
  it('returns "" when there are no deltas and no milestones, even with a state sentence', () => {
    expect(composePriorContext('Cash flow held steady around break-even.', [], [])).toBe('');
  });

  it('returns "" when lastStateSentence is undefined and nothing else survives', () => {
    expect(composePriorContext(undefined, [], [])).toBe('');
  });

  it('matches the spec Design Notes example: milestone suppresses the same-statType delta', () => {
    const result = composePriorContext(
      'Cash flow held steady around break-even.',
      [runwayDelta],
      [runwayMilestone],
    );
    expect(result).toBe(
      'Last week: Cash flow held steady around break-even.\nYour runway dropped below 3 months.',
    );
  });

  it('keeps a delta whose statType has no matching milestone', () => {
    const marginDelta: PriorContextEntry = {
      statType: 'margin_trend',
      kind: 'delta',
      text: 'Margin moved from 19.8% to 22.0%.',
    };
    const result = composePriorContext('Prior state.', [marginDelta], [runwayMilestone]);
    expect(result).toBe('Last week: Prior state.\nYour runway dropped below 3 months.\nMargin moved from 19.8% to 22.0%.');
  });

  it('never suppresses a first_tracked entry, even when its statType matches a milestone', () => {
    const firstTracked: PriorContextEntry = {
      statType: 'runway',
      kind: 'first_tracked',
      text: 'Runway is being tracked for the first time this week, at 2.8 months.',
    };
    const result = composePriorContext(undefined, [firstTracked], [runwayMilestone]);
    expect(result).toBe('Your runway dropped below 3 months.\nRunway is being tracked for the first time this week, at 2.8 months.');
  });

  it('milestone-only, no deltas', () => {
    expect(composePriorContext(undefined, [], [runwayMilestone])).toBe('Your runway dropped below 3 months.');
  });

  it('delta-only, no milestones', () => {
    expect(composePriorContext(undefined, [runwayDelta], [])).toBe('Runway moved from 4.0 to 3.5 months.');
  });

  it('omits the "Last week:" line when lastStateSentence is undefined but content survives', () => {
    const result = composePriorContext(undefined, [runwayDelta], []);
    expect(result).not.toContain('Last week:');
  });
});
