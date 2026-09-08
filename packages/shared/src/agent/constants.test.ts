import { describe, it, expect } from 'vitest';
import { hasDirectiveLanguage, findDirectiveLanguage, BANNED_IMPERATIVES } from './constants.js';

describe('hasDirectiveLanguage', () => {
  it.each(BANNED_IMPERATIVES)('flags %s', (phrase) => {
    expect(hasDirectiveLanguage(`Margins slipped. ${phrase} cut payroll next month.`)).toBe(true);
  });

  it('passes advisory phrasing with no directive language', () => {
    expect(hasDirectiveLanguage('Margins slipped, worth investigating with your accountant.')).toBe(false);
  });

  it('tolerates interior whitespace and line breaks between words', () => {
    expect(hasDirectiveLanguage('you   should\nreview this')).toBe(true);
  });

  it('does not call twice in a row and leak regex lastIndex state', () => {
    // a global-flag regex reused across .test() calls would alternate
    // true/false here if lastIndex weren't reset per call
    expect(hasDirectiveLanguage('you should look into this')).toBe(true);
    expect(hasDirectiveLanguage('you should look into this')).toBe(true);
  });
});

describe('findDirectiveLanguage', () => {
  it('dedupes exact-case repeats but keeps distinct casings as separate entries', () => {
    const phrases = findDirectiveLanguage('You should cut costs. Also, you should raise prices.');
    expect(phrases).toEqual(['You should', 'you should']);
  });

  it('returns multiple distinct phrases when more than one appears', () => {
    const phrases = findDirectiveLanguage('You need to act. I recommend selling the equipment.');
    expect(phrases.map((p) => p.toLowerCase())).toEqual(
      expect.arrayContaining(['you need to', 'i recommend']),
    );
  });

  it('returns an empty array for clean text', () => {
    expect(findDirectiveLanguage('Revenue rose 12%, worth a closer look.')).toEqual([]);
  });
});

// The eval harness flagged this exact sentence on a live generation, and it is
// not advice: it names the revenue figure the business is short of. The check
// runs on every AI summary in production and feeds the admin compliance view, so
// a false positive there is a signal an operator learns to ignore.
describe('the descriptive reading of "you need to"', () => {
  it('does not flag a relative clause naming a figure', () => {
    expect(
      hasDirectiveLanguage(
        "The $40,000 gap between what you're earning and what you need to break even is the source of the burn.",
      ),
    ).toBe(false);
  });

  it('does not flag it after whatever', () => {
    expect(hasDirectiveLanguage('Bring whatever you need to that conversation.')).toBe(false);
  });

  // The exemption is one word wide. Everything the phrase exists to catch still trips.
  it.each([
    'You need to cut payroll next month.',
    'Margins slipped, so you need to raise prices.',
    'you   need\nto move fast',
  ])('still flags the directive form: %s', (text) => {
    expect(hasDirectiveLanguage(text)).toBe(true);
  });

  it('leaves the other banned phrases alone after a relative pronoun', () => {
    expect(hasDirectiveLanguage('It is unclear what you should do next.')).toBe(true);
    expect(hasDirectiveLanguage('That is not what I recommend.')).toBe(true);
  });

  it('reports the phrase it matched, not the exempted one', () => {
    const text = "what you need to break even, but you need to act on the payroll line";
    expect(findDirectiveLanguage(text)).toEqual(['you need to']);
  });
});
