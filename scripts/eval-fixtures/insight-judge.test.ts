import { describe, it, expect } from 'vitest';

import { insightJudge } from './judge-prompts.js';
import { BANNED_IMPERATIVES, hasDirectiveLanguage } from '../../packages/shared/src/agent/constants.js';

// FR22's judge and the legal-posture scan grade the same summary and pull in
// opposite directions if either drifts. The prompt has to keep saying that hedged
// phrasing is fully actionable, because the system template requires hedging: a
// judge that quietly started rewarding "you should" would push the model toward a
// summary that scores well here and fails legal posture, and the eval would report
// both results without anyone seeing the cause.
//
// These assert the prompt's load-bearing clauses rather than any model behaviour,
// which is all that can be checked without a live call.

describe('insightJudge prompt', () => {
  const { system, user } = insightJudge('Revenue fell 12% in March.');

  it('carries the summary in the user half, not the system half', () => {
    expect(user).toContain('Revenue fell 12% in March.');
    expect(system).not.toContain('Revenue fell 12% in March.');
  });

  it('grades both halves of the requirement', () => {
    expect(system).toContain('NON-OBVIOUS');
    expect(system).toContain('ACTIONABLE');
  });

  it('tells the judge that hedged phrasing is still actionable', () => {
    expect(system).toMatch(/hedg/i);
    expect(system).toMatch(/worth investigating/i);
    expect(system).toMatch(/you might consider/i);
  });

  // The specific collision: rewarding an imperative here would drive the model
  // into a legal-posture violation.
  it('tells the judge not to reward the imperatives legal posture bans', () => {
    expect(system).toMatch(/do NOT reward/i);

    const named = BANNED_IMPERATIVES.filter((phrase) => system.toLowerCase().includes(phrase));
    expect(named.length).toBeGreaterThan(0);
  });

  // Both example phrases the prompt holds up as good must actually survive the
  // scan that runs on the real summaries. If BANNED_IMPERATIVES ever grew to
  // cover one of them, the prompt would be teaching the judge to approve
  // something the legal scan rejects.
  it.each(['worth investigating whether the March payroll spike repeats', 'you might consider comparing Q1 to Q2'])(
    'its example of good phrasing survives the directive scan: %s',
    (example) => {
      expect(hasDirectiveLanguage(example)).toBe(false);
    },
  );

  it('demands bare JSON, since the harness parses the reply directly', () => {
    expect(system).toMatch(/JSON only/i);
    expect(system).toContain('"insights"');
    expect(system).toContain('nonObvious');
    expect(system).toContain('actionable');
  });
});
