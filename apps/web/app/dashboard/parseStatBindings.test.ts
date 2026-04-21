import { describe, it, expect } from 'vitest';
import { parseStatBindings } from './parseStatBindings';

describe('parseStatBindings', () => {
  it('extracts a single binding from a tagged paragraph', () => {
    const raw = 'Your runway is 3 months <stat id="runway"/> at this burn.';
    expect(parseStatBindings(raw)).toEqual([{ paragraphIndex: 0, statId: 'runway' }]);
  });

  it('aligns paragraph indices with double-newline splits', () => {
    const raw = [
      'Opening framing with no tag.',
      'Cash flow is negative <stat id="cash_flow"/> each month.',
      'Runway sits at about 4 months <stat id="runway"/>.',
    ].join('\n\n');

    expect(parseStatBindings(raw)).toEqual([
      { paragraphIndex: 1, statId: 'cash_flow' },
      { paragraphIndex: 2, statId: 'runway' },
    ]);
  });

  it('takes the first tag when a paragraph has multiple', () => {
    const raw = 'Margin and cash <stat id="margin_trend"/> both <stat id="cash_flow"/> shrinking.';
    expect(parseStatBindings(raw)).toEqual([{ paragraphIndex: 0, statId: 'margin_trend' }]);
  });

  it('returns empty array when no tags are present', () => {
    const raw = 'Just prose.\n\nMore prose.\n\nEven more.';
    expect(parseStatBindings(raw)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseStatBindings('')).toEqual([]);
  });

  it('ignores malformed tags (no crash, no binding)', () => {
    const raw = 'bad <stat id=/> tag and good <stat id="runway"/> tag.';
    // the paragraph has both; the complete-tag regex matches only the good one
    expect(parseStatBindings(raw)).toEqual([{ paragraphIndex: 0, statId: 'runway' }]);
  });

  it('filters empty paragraphs so indices stay stable', () => {
    // triple newline creates an empty segment; .filter(Boolean) drops it,
    // keeping paragraph indices aligned with the rendered output
    const raw = 'first <stat id="a"/>\n\n\n\nsecond <stat id="b"/>';
    expect(parseStatBindings(raw)).toEqual([
      { paragraphIndex: 0, statId: 'a' },
      { paragraphIndex: 1, statId: 'b' },
    ]);
  });
});
