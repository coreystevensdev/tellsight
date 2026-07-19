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
});
