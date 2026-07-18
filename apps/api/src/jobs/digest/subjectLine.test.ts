import { describe, it, expect } from 'vitest';

import { generateSubjectLine, containsSpamTrigger } from './subjectLine.js';
import type { FirstTimeMilestone, FirstTimeMilestoneKind } from './firstTimeMilestones.js';
import type { TransitionMilestone } from './milestones.js';

const ORG_NAME = 'Acme Co';
const NO_FIRST_TIME: FirstTimeMilestone[] = [];

function milestone(kind: TransitionMilestone['kind'], label: string): TransitionMilestone {
  return { kind, label, statType: 'runway' };
}

function firstTime(kind: FirstTimeMilestoneKind, label: string): FirstTimeMilestone {
  return { kind, label, statType: null };
}

describe('generateSubjectLine', () => {
  it.each([
    [
      'concerning week, concerning milestone fired: leads with milestone phrase',
      'concerning' as const,
      [milestone('runway_dropped_below_3mo', 'Your runway dropped below 3 months.')],
      'Your runway needs attention - Acme Co weekly insights',
    ],
    [
      'concerning week, no milestone: generic runway-attention fallback',
      'concerning' as const,
      [],
      'Your runway needs a look - Acme Co weekly insights',
    ],
    [
      'concerning valence beats a positive milestone that also fired',
      'concerning' as const,
      [milestone('turned_cash_positive', 'You turned cash-flow positive.')],
      'Your runway needs a look - Acme Co weekly insights',
    ],
    [
      'watching week, positive milestone fired: milestone phrase leads',
      'watching' as const,
      [milestone('crossed_break_even', 'Revenue now covers your fixed costs.')],
      "You've cleared break-even - Acme Co weekly insights",
    ],
    [
      'watching week, concerning milestone fired: still outranks the generic fallback',
      'watching' as const,
      [milestone('turned_cash_negative', 'You started burning cash this month.')],
      'Your cash flow just flipped negative - Acme Co weekly insights',
    ],
    [
      'positive valence, no milestone: generic positive fallback',
      'positive' as const,
      [],
      'Good momentum this week - Acme Co weekly insights',
    ],
    [
      'neutral valence, no milestone: plain fallback string, no topic phrase',
      'neutral' as const,
      [],
      'Acme Co weekly insights',
    ],
    [
      'forecast_crosses_zero milestone: dedicated phrase, never the numbered label',
      'watching' as const,
      [milestone('forecast_crosses_zero', 'Your forecast now dips below zero within 2 months.')],
      'Your forecast is trending toward a shortfall - Acme Co weekly insights',
    ],
  ])('%s', (_desc, valence, transitionMilestones, expected) => {
    expect(generateSubjectLine(valence, NO_FIRST_TIME, transitionMilestones, ORG_NAME)).toBe(expected);
  });

  it('never surfaces the numbered milestone label in the subject', () => {
    const subject = generateSubjectLine(
      'watching',
      NO_FIRST_TIME,
      [milestone('runway_extended_past_6mo', 'Your runway extended past 6 months.')],
      ORG_NAME,
    );
    expect(subject).not.toContain('6 months');
    expect(subject).toBe('Your runway just got healthier - Acme Co weekly insights');
  });

  it('a first-time milestone outranks a concerning valence', () => {
    const subject = generateSubjectLine(
      'concerning',
      [firstTime('first_profitable_month', 'This is your first profitable month.')],
      [milestone('runway_dropped_below_3mo', 'Your runway dropped below 3 months.')],
      ORG_NAME,
    );
    expect(subject).toBe("You've hit your first profitable month - Acme Co weekly insights");
  });

  it('a first-time milestone outranks a fired positive transition milestone', () => {
    const subject = generateSubjectLine(
      'watching',
      [firstTime('first_break_even', 'For the first time, revenue covered your fixed costs.')],
      [milestone('crossed_break_even', 'Revenue now covers your fixed costs.')],
      ORG_NAME,
    );
    expect(subject).toBe('Revenue covered your fixed costs for the first time - Acme Co weekly insights');
  });

  it('uses the dedicated streak phrase, never a numbered label', () => {
    const subject = generateSubjectLine(
      'positive',
      [firstTime('first_three_profitable_streak', "You've had three profitable months in a row for the first time.")],
      [],
      ORG_NAME,
    );
    expect(subject).not.toMatch(/\d/);
    expect(subject).toBe("You've strung together your first multi-month profitable streak - Acme Co weekly insights");
  });

  it('when multiple first-time milestones fire together, the first one detected wins the subject', () => {
    const subject = generateSubjectLine(
      'positive',
      [
        firstTime('first_profitable_month', 'This is your first profitable month.'),
        firstTime('first_break_even', 'For the first time, revenue covered your fixed costs.'),
      ],
      [],
      ORG_NAME,
    );
    expect(subject).toBe("You've hit your first profitable month - Acme Co weekly insights");
  });
});

describe('containsSpamTrigger', () => {
  it.each([
    'Your runway needs attention - Acme Co weekly insights',
    'Your runway needs a look - Acme Co weekly insights',
    "You're generating a cash surplus - Acme Co weekly insights",
    "You've cleared break-even - Acme Co weekly insights",
    'Your runway just got healthier - Acme Co weekly insights',
    'Your margins are trending up - Acme Co weekly insights',
    'Your cash flow just flipped negative - Acme Co weekly insights',
    'Your forecast is trending toward a shortfall - Acme Co weekly insights',
    'Good momentum this week - Acme Co weekly insights',
    "Here's what changed this week - Acme Co weekly insights",
    'Acme Co weekly insights',
  ])('canned template is clean: %s', (subject) => {
    expect(containsSpamTrigger(subject)).toBe(false);
  });

  it.each([
    'FREE cash for your business!!!',
    'Act now before it expires',
    'This is your URGENT reminder',
    'Get cash now, guaranteed',
    'Limited time offer, click here',
    'You are a WINNER',
    'risk-free trial, 100% off',
  ])('flags known spam vocabulary: %s', (subject) => {
    expect(containsSpamTrigger(subject)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(containsSpamTrigger('ACT NOW')).toBe(true);
    expect(containsSpamTrigger('act now')).toBe(true);
  });
});
