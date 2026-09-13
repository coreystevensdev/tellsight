import { describe, it, expect } from 'vitest';
import { EMPTY_FILTERS, filtersToQuery, filtersFromQuery, type FilterState } from './filterParams';

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
    const query = filtersToQuery({
      datePreset: 'last-3-months',
      category: 'Payroll',
      granularity: 'weekly',
    });
    expect(parse(query)).toEqual({
      datePreset: 'last-3-months',
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
    expect(parse('date=last-month&utm_source=email&page=2')).toEqual({
      datePreset: 'last-month',
      category: null,
      granularity: 'monthly',
    });
  });
});

describe('round trip', () => {
  const cases: FilterState[] = [
    EMPTY_FILTERS,
    { datePreset: 'all', category: null, granularity: 'monthly' },
    { datePreset: 'last-year', category: 'Marketing', granularity: 'weekly' },
    { datePreset: null, category: 'Cost of Goods Sold', granularity: 'monthly' },
  ];

  it.each(cases)('survives a trip through the URL: %j', (filters) => {
    expect(parse(filtersToQuery(filters))).toEqual(filters);
  });
});
