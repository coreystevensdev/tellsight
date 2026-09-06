import { describe, it, expect } from 'vitest';

import { createStatCorrectionSchema } from './stat-corrections.js';

// note's upper bound was unpinned: removing .max(1000) while keeping .min(1) left
// every suite green, and this field is free text written straight into a column.

function correction(over: Record<string, unknown> = {}) {
  return { statInstanceId: 'stat-1', datasetId: 1, note: 'Refund was miscategorised', ...over };
}

describe('createStatCorrectionSchema note bounds', () => {
  it('accepts a note at exactly the ceiling', () => {
    expect(createStatCorrectionSchema.safeParse(correction({ note: 'x'.repeat(1000) })).success).toBe(true);
  });

  it('rejects a note one character past it', () => {
    expect(createStatCorrectionSchema.safeParse(correction({ note: 'x'.repeat(1001) })).success).toBe(false);
  });

  it('rejects unbounded free text', () => {
    expect(createStatCorrectionSchema.safeParse(correction({ note: 'x'.repeat(100_000) })).success).toBe(false);
  });

  it.each([['empty', ''], ['only whitespace', '   ']])('rejects a note that is %s', (_label, note) => {
    expect(createStatCorrectionSchema.safeParse(correction({ note })).success).toBe(false);
  });

  // trim runs before the length checks, so padding cannot smuggle a value past
  // either bound.
  it('trims before measuring, at both ends of the range', () => {
    const padded = createStatCorrectionSchema.safeParse(correction({ note: '  hello  ' }));

    expect(padded.success && padded.data.note).toBe('hello');
    expect(createStatCorrectionSchema.safeParse(correction({ note: ` ${'x'.repeat(1000)} ` })).success).toBe(true);
  });
});
