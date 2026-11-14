import { describe, it, expect } from 'vitest';

import { formatGloss, scorePlainLanguage } from './plain-language.js';

// Verbatim from a v2.3 run on cash-crunch, stat and cite tags stripped. Kept
// real rather than hand-written because the question this check answers is
// whether production prose passes it, and a fixture I invented would only prove
// my own regex consistent with itself.
const REAL_SUMMARY =
  'Your runway is about 2.4 months, which is a tight window worth discussing with your ' +
  'accountant before it closes. The cash balance started at $24,000 in January and trends ' +
  'toward $10,500 next month, crossing zero around mid-March if this pattern continues. ' +
  'The monthly burn has been accelerating over the last six months, from -$7,500 in July to ' +
  '-$12,500 in December, while revenue slid from $44,000 to $40,000 over the same stretch. ' +
  'Break-even sits at about $80,000/mo against your current $40,000, roughly double where ' +
  'you are now. At a 20% margin, most of each new dollar is covering fixed costs.';

describe('scorePlainLanguage', () => {
  it('passes real production prose', () => {
    // The terms this prose uses are the prompt's own vocabulary, so penalising
    // them would mean the eval grading against production's instructions.
    expect(scorePlainLanguage(REAL_SUMMARY).pass).toBe(true);
  });

  it('fails on accountant register the prompt never uses', () => {
    const r = scorePlainLanguage('Your EBITDA improved while working capital tightened.');
    expect(r.pass).toBe(false);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]).toContain('EBITDA');
  });

  it('quotes the sentence, so a violation is actionable without rerunning', () => {
    const r = scorePlainLanguage('Revenue rose. Liquidity is thin this quarter. Costs held.');
    expect(r.violations[0]).toContain('Liquidity is thin this quarter.');
  });

  it('catches the abbreviations an owner would have to look up', () => {
    for (const t of ['YoY', 'CAGR', 'opex', 'ROI']) {
      expect(scorePlainLanguage(`Growth was strong on a ${t} basis.`).pass).toBe(false);
    }
  });

  it("does not fire on the prompt's own words", () => {
    for (const t of [
      'runway',
      'burn rate',
      'margin',
      'break-even',
      'fixed costs',
      'structural',
      'aggregate',
    ]) {
      expect(scorePlainLanguage(`The ${t} is worth a look with your accountant.`).pass).toBe(true);
    }
  });

  it('reports unglossed terms without failing on them', () => {
    const r = scorePlainLanguage(REAL_SUMMARY);
    // Reported so the gap is visible, ungated so a healthy run stays green.
    expect(r.pass).toBe(true);
    expect(r.unglossed).toContain('runway');
  });

  it('no longer counts the terms v2.4 blessed as ordinary', () => {
    // v2.3 asked for a parenthetical on any financial term and got one zero
    // times. v2.4 narrows the ask to runway and burn rate, so margin and
    // break-even used bare are compliant and must not register.
    const r = scorePlainLanguage(REAL_SUMMARY);
    expect(r.unglossed).not.toContain('margin');
    expect(r.unglossed).not.toContain('break-even');
  });

  it('counts burn rate, the other term v2.4 names', () => {
    const bare = 'The burn rate has been accelerating since July.';
    expect(scorePlainLanguage(bare).unglossed).toContain('burn rate');

    const glossed =
      'The burn rate (how much more you spend than you take in each month) has been accelerating.';
    expect(scorePlainLanguage(glossed).unglossed).not.toContain('burn rate');
  });

  it('counts a prose parenthetical as a gloss and a bare figure as not', () => {
    const glossed = 'Your runway (the months of cash left at this spend rate) is about 2.4 months.';
    expect(scorePlainLanguage(glossed).unglossed).not.toContain('runway');

    const figureOnly = 'Your runway ($24,000) is about 2.4 months.';
    expect(scorePlainLanguage(figureOnly).unglossed).toContain('runway');

    // Long enough that a length threshold would wave it through, so this is
    // the case that pins the prose rule itself rather than the string's size.
    const longFigures = 'Your runway ($24,000.00 of $41,500.00) is about 2.4 months.';
    expect(scorePlainLanguage(longFigures).unglossed).toContain('runway');
  });
  it('tells a term that was never used apart from one that was glossed', () => {
    // The distinction the aggregate cannot make. This prose says "monthly burn"
    // and never "burn rate", so the term is in neither list, while runway is
    // used bare and lands in unglossed. Reading only unglossed, both terms look
    // equally compliant, and a prompt change that stopped the model saying
    // "burn rate" at all would have scored as a perfect gloss rate.
    const r = scorePlainLanguage(REAL_SUMMARY);
    expect(r.unglossed).toContain('runway');
    expect(r.glossed).not.toContain('burn rate');
    expect(r.unglossed).not.toContain('burn rate');
  });

  it('records a used-and-glossed term in glossed', () => {
    const glossed =
      'The burn rate (how much more you spend than you take in each month) has been accelerating.';
    const r = scorePlainLanguage(glossed);
    expect(r.glossed).toContain('burn rate');
    expect(r.unglossed).not.toContain('burn rate');
  });
});

describe('an arm whose prompt carries no gloss rule', () => {
  // v1-agent-system.md names runway and burn rate and says the opposite of
  // v2.4 rule 9: use them plainly, and if a term needs a definition it needs a
  // different term. Scoring that arm's glosses measured a rule it was never
  // given, and reported 0 of 35 as though it were a failure.
  it('returns null rather than an empty list, so nothing reads as a clean sweep', () => {
    const r = scorePlainLanguage(REAL_SUMMARY, { hasGlossRule: false });
    expect(r.unglossed).toBeNull();
    expect(r.glossed).toBeNull();
  });

  it('still applies the off-vocabulary half, which both prompts share', () => {
    const r = scorePlainLanguage('Your EBITDA improved this quarter.', { hasGlossRule: false });
    expect(r.pass).toBe(false);
    expect(r.violations.join(' ')).toMatch(/EBITDA/i);
  });

  it('says so in the per-sample line instead of looking compliant', () => {
    expect(formatGloss(scorePlainLanguage(REAL_SUMMARY, { hasGlossRule: false }))).toBe(
      'no gloss rule',
    );
  });
});

describe('formatGloss', () => {
  it('names each term and its state', () => {
    const both =
      'Your runway (the months of cash left at this spend rate) is 2.4 months and the burn rate is rising.';
    expect(formatGloss(scorePlainLanguage(both))).toBe('runway glossed, burn rate bare');
  });

  it('says so when no term appeared, rather than reading as a clean pass', () => {
    expect(formatGloss(scorePlainLanguage('Revenue rose and costs held.'))).toBe('no terms used');
  });
});
