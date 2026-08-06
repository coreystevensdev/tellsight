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
