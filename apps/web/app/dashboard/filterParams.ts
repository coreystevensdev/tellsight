import type { Granularity } from 'shared/types';

export interface FilterState {
  datePreset: string | null;
  category: string | null;
  granularity: Granularity;
}

export const DATE_PRESETS = [
  { label: 'All time', value: 'all' },
  { label: 'Last month', value: 'last-month' },
  { label: 'Last 3 months', value: 'last-3-months' },
  { label: 'Last 6 months', value: 'last-6-months' },
  { label: 'Last year', value: 'last-year' },
] as const;

export type DatePresetValue = (typeof DATE_PRESETS)[number]['value'];

export const EMPTY_FILTERS: FilterState = {
  datePreset: null,
  category: null,
  granularity: 'monthly',
};

const PRESET_VALUES: ReadonlySet<string> = new Set(DATE_PRESETS.map((p) => p.value));

// chartFiltersSchema caps a category at 100 chars, so anything longer would be
// rejected by the API anyway and is treated as absent here.
const MAX_CATEGORY_LENGTH = 100;

// Structural rather than ReadonlyURLSearchParams, so this stays testable with a
// plain URLSearchParams and does not pull next/navigation into a pure module.
interface ReadableParams {
  get(name: string): string | null;
}

// Only non-default values are written: an unfiltered dashboard keeps a bare URL
// rather than one carrying three params that say nothing.
export function filtersToQuery(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.datePreset) params.set('date', filters.datePreset);
  if (filters.category) params.set('category', filters.category);
  if (filters.granularity !== 'monthly') params.set('granularity', filters.granularity);
  return params.toString();
}

// Every unrecognised value falls back to its default rather than throwing. These
// arrive from a URL someone can hand-edit, truncate or paste half of, and a
// dashboard that renders unfiltered is a better answer than one that crashes.
export function filtersFromQuery(params: ReadableParams): FilterState {
  const date = params.get('date');
  const category = params.get('category');

  return {
    datePreset: date && PRESET_VALUES.has(date) ? date : null,
    category: category && category.length <= MAX_CATEGORY_LENGTH ? category : null,
    granularity: params.get('granularity') === 'weekly' ? 'weekly' : 'monthly',
  };
}
