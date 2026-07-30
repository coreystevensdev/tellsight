import { describe, it, expect } from 'vitest';
import { parseCiteBindings } from './parseCiteBindings';

describe('parseCiteBindings', () => {
  it('binds a cite tag to the dollar number it immediately follows', () => {
    const raw = 'Revenue hit $5,000<cite id="1:total:Sales:category"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:total:Sales:category' },
    ]);
  });

  it('binds a cite tag to a percent number', () => {
    const raw = 'Margin grew 12%<cite id="1:margin_trend:_:_"/> this quarter.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:margin_trend:_:_' },
    ]);
  });

  it('binds multiple citations in the same paragraph to their own numbers', () => {
    const raw =
      'Revenue was $5,000<cite id="1:total:Sales:category"/> and margin held at 12%<cite id="1:margin_trend:_:_"/>.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:total:Sales:category' },
      { paragraphIndex: 0, numberIndex: 1, statId: '1:margin_trend:_:_' },
    ]);
  });

  it('returns empty array when no citations are present', () => {
    const raw = 'Revenue was $5,000 and margin held at 12% this quarter.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseCiteBindings('')).toEqual([]);
  });

  it('a colon-heavy, slash-containing instance id survives capture', () => {
    const raw = 'Cash on hand is $3,000<cite id="1:total:Travel/Meals:category"/> today.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:total:Travel/Meals:category' },
    ]);
  });

  it('drops a tag that does not sit right after a number', () => {
    const raw = 'Revenue was $5,000, up nicely <cite id="1:total:Sales:category"/> this quarter.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('does not treat a number-shaped category name inside the tag id as a phantom number', () => {
    const raw = 'Spending was $8,000<cite id="1:total:50% Off:category"/> this quarter.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:total:50% Off:category' },
    ]);
  });

  it('aligns paragraph indices with double-newline splits', () => {
    const raw = [
      'Opening framing with no numbers.',
      'Revenue hit $5,000<cite id="1:total:Sales:category"/> this month.',
    ].join('\n\n');
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 1, numberIndex: 0, statId: '1:total:Sales:category' },
    ]);
  });

  it('binds two consecutive cite tags to the same number', () => {
    const raw = 'Revenue hit $5,000<cite id="A"/><cite id="B"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: 'A' },
      { paragraphIndex: 0, numberIndex: 0, statId: 'B' },
    ]);
  });

  it('binds three consecutive cite tags to the same number', () => {
    const raw = 'Revenue hit $5,000<cite id="A"/><cite id="B"/><cite id="C"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: 'A' },
      { paragraphIndex: 0, numberIndex: 0, statId: 'B' },
      { paragraphIndex: 0, numberIndex: 0, statId: 'C' },
    ]);
  });

  it('binds a cite tag missing its trailing slash the same as a well-formed one', () => {
    const raw = 'Revenue hit $5,000<cite id="1:total:Sales:category"> this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: '1:total:Sales:category' },
    ]);
  });

  it('drops a whole chain of cite tags when the first one does not sit right after a number', () => {
    const raw = 'Revenue was $5,000 up nicely<cite id="A"/><cite id="B"/> this quarter.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('binds a tag right after a number even when the previous tag in the chain was rejected for a gap', () => {
    const raw = 'Revenue hit $5,000<cite id="A"/> extra <cite id="B"/><cite id="C"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'A' }]);
  });

  it('does not bind an empty-id cite tag, even immediately after a number', () => {
    const raw = 'Revenue hit $5,000<cite id=""/> this month.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('does not bind a bare cite tag, even immediately after a number', () => {
    const raw = 'Revenue hit $5,000<cite/> this month.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('binds a cite tag forward to the number right after it', () => {
    const raw = '<cite id="X"/>$5,000 total this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'X' }]);
  });

  it('binds a chain of cite tags forward to the number that follows them', () => {
    const raw = '<cite id="A"/><cite id="B"/>$5,000 total this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: 'A' },
      { paragraphIndex: 0, numberIndex: 0, statId: 'B' },
    ]);
  });

  it('drops a forward-pending tag when the gap to the next number is not whitespace-only', () => {
    const raw = '<cite id="X"/> up nicely $5,000 this quarter.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('dedupes two consecutive tags sharing an id bound backward to the same number', () => {
    const raw = '$5,000<cite id="X"/><cite id="X"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'X' }]);
  });

  it('dedupes two consecutive tags sharing an id bound forward to the same number', () => {
    const raw = '<cite id="X"/><cite id="X"/>$5,000 this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'X' }]);
  });

  it('keeps two bindings for the same id when it is cited near two different numbers', () => {
    const raw = '$5,000<cite id="X"/> and 12%<cite id="X"/> this quarter.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: 'X' },
      { paragraphIndex: 0, numberIndex: 1, statId: 'X' },
    ]);
  });

  it('dedupes an id bound forward with one bound backward to the same number', () => {
    const raw = '<cite id="X"/>$5,000<cite id="X"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'X' }]);
  });

  it('drops a whole multi-id forward-pending chain when the gap to the number is not whitespace-only', () => {
    const raw = '<cite id="A"/><cite id="B"/> up nicely $5,000 this quarter.';
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('dedupes non-consecutive repeats of the same id within one number', () => {
    const raw = '$5,000<cite id="X"/><cite id="A"/><cite id="X"/> this month.';
    expect(parseCiteBindings(raw)).toEqual([
      { paragraphIndex: 0, numberIndex: 0, statId: 'X' },
      { paragraphIndex: 0, numberIndex: 0, statId: 'A' },
    ]);
  });

  it('does not let a forward-pending tag from one paragraph resolve against the next paragraph', () => {
    const raw = ['<cite id="X"/> up nicely', 'Revenue hit $5,000 this month.'].join('\n\n');
    expect(parseCiteBindings(raw)).toEqual([]);
  });

  it('restarts the forward-pending chain after a gap instead of extending it', () => {
    const raw = '<cite id="A"/> gap <cite id="B"/>$5,000 this month.';
    expect(parseCiteBindings(raw)).toEqual([{ paragraphIndex: 0, numberIndex: 0, statId: 'B' }]);
  });
});
