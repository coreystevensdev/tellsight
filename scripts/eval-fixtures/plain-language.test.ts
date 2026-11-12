import { describe, it, expect } from 'vitest';

import { scorePlainLanguage } from './plain-language.js';

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
    // Rule 9 asks for a parenthetical on first use and production never gives
    // one. Reported so the gap is visible, ungated so a healthy run stays green.
    expect(r.pass).toBe(true);
    expect(r.unglossed).toContain('runway');
    expect(r.unglossed).toContain('margin');
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
});
