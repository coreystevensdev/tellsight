import { describe, it, expect } from 'vitest';
import { EMPTY_FILTERS, customRange, filtersToQuery, filtersFromQuery, type FilterState } from './filterParams';

const parse = (query: string) => filtersFromQuery(new URLSearchParams(query));

describe('filtersToQuery', () => {
  // An unfiltered dashboard should not carry three params that say nothing, or
  // every share link starts with noise.
  it('writes nothing for the default filters', () => {
    expect(filtersToQuery(EMPTY_FILTERS)).toBe('');
  });

  it('omits monthly, which is the default granularity', () => {
    expect(filtersToQuery({ ...EMPTY_FILTERS, granularity: 'monthly' })).toBe('');
    expect(filtersToQuery({ ...EMPTY_FILTERS, granularity: 'weekly' })).toBe('granularity=weekly');
  });

  it('writes each filter that is set', () => {
    const query = filtersToQuery({ ...EMPTY_FILTERS, datePreset: 'last-3-months',
      category: 'Payroll',
      granularity: 'weekly',
    });
    expect(parse(query)).toEqual({ ...EMPTY_FILTERS, datePreset: 'last-3-months',
      category: 'Payroll',
      granularity: 'weekly',
    });
  });

  // Categories are user data and arrive from uploaded CSV headers, so they carry
  // whatever the spreadsheet had in them.
  it('survives a category with characters that need encoding', () => {
    const category = 'Rent & Utilities / Q1 50%';
    const query = filtersToQuery({ ...EMPTY_FILTERS, category });
    expect(query).not.toContain(' ');
    expect(parse(query).category).toBe(category);
  });
});

describe('filtersFromQuery', () => {
  it('returns the defaults for an empty query', () => {
    expect(parse('')).toEqual(EMPTY_FILTERS);
  });

  // Everything below is reachable by hand-editing the address bar or pasting
  // half a link, so none of it may throw.
  it('falls back to no date filter for an unknown preset', () => {
    expect(parse('date=last-century').datePreset).toBeNull();
    expect(parse('date=').datePreset).toBeNull();
  });

  it('accepts every preset the filter bar offers', () => {
    for (const value of ['all', 'last-month', 'last-3-months', 'last-6-months', 'last-year']) {
      expect(parse(`date=${value}`).datePreset).toBe(value);
    }
  });

  // chartFiltersSchema caps a category at 100 chars, so a longer one would be
  // rejected by the API. Dropping it here means the dashboard renders unfiltered
  // instead of firing a request that cannot succeed.
  it('drops a category longer than the API accepts', () => {
    expect(parse(`category=${'x'.repeat(100)}`).category).toHaveLength(100);
    expect(parse(`category=${'x'.repeat(101)}`).category).toBeNull();
  });

  it('falls back to monthly for anything that is not weekly', () => {
    expect(parse('granularity=weekly').granularity).toBe('weekly');
    expect(parse('granularity=daily').granularity).toBe('monthly');
    expect(parse('granularity=').granularity).toBe('monthly');
  });

  it('ignores params it does not own', () => {
    expect(parse('date=last-month&utm_source=email&page=2')).toEqual({ ...EMPTY_FILTERS, datePreset: 'last-month',
      category: null,
      granularity: 'monthly',
    });
  });
});

describe('round trip', () => {
  const cases: FilterState[] = [
    EMPTY_FILTERS,
    { ...EMPTY_FILTERS, datePreset: 'all', category: null, granularity: 'monthly' },
    { ...EMPTY_FILTERS, datePreset: 'last-year', category: 'Marketing', granularity: 'weekly' },
    { ...EMPTY_FILTERS, datePreset: null, category: 'Cost of Goods Sold', granularity: 'monthly' },
  ];

  it.each(cases)('survives a trip through the URL: %j', (filters) => {
    expect(parse(filtersToQuery(filters))).toEqual(filters);
  });
});

describe('customRange', () => {
  const custom = (dateFrom: string | null, dateTo: string | null): FilterState =>
    ({ ...EMPTY_FILTERS, datePreset: 'custom', dateFrom, dateTo });

  it('returns the endpoints when both are real and in order', () => {
    expect(customRange(custom('2026-01-01', '2026-03-31'))).toEqual({
      from: '2026-01-01',
      to: '2026-03-31',
    });
  });

  it('accepts a single-day range', () => {
    expect(customRange(custom('2026-01-01', '2026-01-01'))?.from).toBe('2026-01-01');
  });

  // Half a range is not a narrower view, it is an unanswerable question, so it
  // reads as no date filter rather than as an empty result. The user is still
  // mid-edit at this point and should not watch their charts blank out.
  it('returns null while only one endpoint is filled', () => {
    expect(customRange(custom('2026-01-01', null))).toBeNull();
    expect(customRange(custom(null, '2026-03-31'))).toBeNull();
  });

  it('returns null for a backwards range', () => {
    expect(customRange(custom('2026-03-31', '2026-01-01'))).toBeNull();
  });

  // Date.parse takes 2026-02-30 and rolls it into March, which would quietly
  // shift a range the user picked rather than rejecting it.
  it('rejects a date that looks valid and is not', () => {
    expect(customRange(custom('2026-02-30', '2026-03-31'))).toBeNull();
    expect(customRange(custom('2026-13-01', '2026-03-31'))).toBeNull();
    expect(customRange(custom('not-a-date', '2026-03-31'))).toBeNull();
  });

  it('ignores the endpoints unless the preset is custom', () => {
    expect(customRange({ ...EMPTY_FILTERS, datePreset: 'last-month', dateFrom: '2026-01-01', dateTo: '2026-03-31' })).toBeNull();
  });
});

describe('custom range in the URL', () => {
  it('round-trips a complete range', () => {
    const filters: FilterState = {
      ...EMPTY_FILTERS,
      datePreset: 'custom',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
    };
    expect(filtersFromQuery(new URLSearchParams(filtersToQuery(filters)))).toEqual(filters);
  });

  // Otherwise a link carries dates that nothing reads, and switching back to
  // custom would restore a range the user had moved off.
  it('does not write the endpoints when the preset is not custom', () => {
    const query = filtersToQuery({
      ...EMPTY_FILTERS,
      datePreset: 'last-month',
      dateFrom: '2026-01-01',
      dateTo: '2026-03-31',
    });
    expect(query).not.toContain('from=');
    expect(query).not.toContain('to=');
  });

  it('drops hand-edited endpoints when the preset is not custom', () => {
    const parsed = filtersFromQuery(new URLSearchParams('date=last-year&from=2026-01-01&to=2026-03-31'));
    expect(parsed.dateFrom).toBeNull();
    expect(parsed.dateTo).toBeNull();
  });

  it('keeps a valid endpoint and drops an invalid one', () => {
    const parsed = filtersFromQuery(new URLSearchParams('date=custom&from=2026-01-01&to=2026-02-30'));
    expect(parsed.dateFrom).toBe('2026-01-01');
    expect(parsed.dateTo).toBeNull();
    expect(customRange(parsed)).toBeNull();
  });
});
