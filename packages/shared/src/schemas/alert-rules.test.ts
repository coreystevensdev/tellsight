import { describe, it, expect } from 'vitest';

import { alertRuleSchema } from './alert-rules.js';

// Three bounds in this file were unpinned: removing the muteUntil future refine,
// and removing either the floor or the 24-month ceiling on the runway threshold,
// all left the shared, api and web suites green.

function runwayRule(over: Record<string, unknown> = {}) {
  return {
    kind: 'runway_runs_short',
    threshold: { months: 6 },
    enabled: true,
    ...over,
  };
}

const inFuture = new Date(Date.now() + 86_400_000).toISOString();
const inPast = new Date(Date.now() - 86_400_000).toISOString();

describe('alertRuleSchema muteUntil', () => {
  it.each([
    ['a future timestamp', inFuture, true],
    ['null', null, true],
    ['omitted', undefined, true],
  ])('accepts %s', (_label, muteUntil, ok) => {
    const input = muteUntil === undefined ? runwayRule() : runwayRule({ muteUntil });

    expect(alertRuleSchema.safeParse(input).success).toBe(ok);
  });

  // A mute that has already elapsed is not a mute. Accepting one stores a value
  // every downstream comparison then ignores, which reads as a silently
  // ineffective setting rather than an error the user can see.
  it('rejects a timestamp already in the past', () => {
    const result = alertRuleSchema.safeParse(runwayRule({ muteUntil: inPast }));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes('must be in the future'))).toBe(true);
  });

  it('rejects a non-datetime string', () => {
    expect(alertRuleSchema.safeParse(runwayRule({ muteUntil: 'next tuesday' })).success).toBe(false);
  });
});

describe('alertRuleSchema runway threshold bounds', () => {
  it.each([1, 6, 24])('accepts %s months', (months) => {
    expect(alertRuleSchema.safeParse(runwayRule({ threshold: { months } })).success).toBe(true);
  });

  // The ceiling is a UX judgement rather than a mathematical bound: a runway
  // concern beyond two years is not an actionable "short runway" alert.
  it.each([25, 100, 1_000])('rejects %s months, past the ceiling', (months) => {
    expect(alertRuleSchema.safeParse(runwayRule({ threshold: { months } })).success).toBe(false);
  });

  // Zero or negative would fire the alert permanently, or never.
  it.each([0, -1, -12])('rejects %s months, at or below the floor', (months) => {
    expect(alertRuleSchema.safeParse(runwayRule({ threshold: { months } })).success).toBe(false);
  });
});
