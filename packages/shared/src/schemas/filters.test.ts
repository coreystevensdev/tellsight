import { describe, it, expect } from 'vitest';
import { chartFiltersSchema, granularitySchema } from './filters.js';

describe('chartFiltersSchema', () => {
  // The charts route decides whether a request is filtered by asking whether any
  // of these four came back set. If parsing an empty query ever starts inventing
  // a granularity, every unfiltered dashboard request silently becomes a filtered
  // one and the `filtered` field in the logs stops meaning anything.
  //
  // This is not hypothetical. granularitySchema used to end in .default('monthly'),
  // which zod 3 discards once .optional() is chained after it, so the default had
  // never once fired. zod 4 applies it, and the same empty query parses to
  // { granularity: 'monthly' }. That difference is the whole reason this test exists:
  // it fails on the version bump rather than letting the route change behaviour quietly.
  it('leaves an empty query empty', () => {
    expect(chartFiltersSchema.parse({})).toEqual({});
  });

  it('leaves an explicitly undefined granularity absent', () => {
    expect(chartFiltersSchema.parse({ granularity: undefined })).toEqual({});
  });

  it('keeps a granularity the caller actually asked for', () => {
    expect(chartFiltersSchema.parse({ granularity: 'weekly' })).toEqual({ granularity: 'weekly' });
  });

  it('rejects a granularity outside the two the charts can bucket by', () => {
    expect(granularitySchema.safeParse('daily').success).toBe(false);
  });
});
