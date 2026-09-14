import type { Granularity } from 'shared/types';

export interface FilterState {
  datePreset: string | null;
  // Only meaningful when datePreset is 'custom'. Kept as ISO calendar dates
  // rather than Date objects so they survive the URL unchanged.
  dateFrom: string | null;
  dateTo: string | null;
  category: string | null;
  granularity: Granularity;
}

// The presets stay the primary affordance: they were chosen because the persona
// thinks in "last quarter" rather than in dates, and they cover most use. Custom
// is the escape hatch for the rest, which is mostly calendar-aligned work like a
// tax year that no rolling window can express.
export const DATE_PRESETS = [
  { label: 'All time', value: 'all' },
  { label: 'Last month', value: 'last-month' },
  { label: 'Last 3 months', value: 'last-3-months' },
  { label: 'Last 6 months', value: 'last-6-months' },
  { label: 'Last year', value: 'last-year' },
  { label: 'Custom range', value: 'custom' },
] as const;

export const CUSTOM_PRESET = 'custom';

export type DatePresetValue = (typeof DATE_PRESETS)[number]['value'];

export const EMPTY_FILTERS: FilterState = {
  datePreset: null,
  dateFrom: null,
  dateTo: null,
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
// An ISO calendar date that is also a real one: Date.parse accepts 2026-02-30
// and rolls it into March, which would silently shift a range the user chose.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asCalendarDate(value: string | null): string | null {
  if (!value || !ISO_DATE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

// Returns the endpoints only when both are present, real and in order. A
// half-filled or backwards range is not a narrower view, it is an unanswerable
// question, so it reads as no date filter rather than as an empty result.
export function customRange(filters: FilterState): { from: string; to: string } | null {
  if (filters.datePreset !== CUSTOM_PRESET) return null;
  const from = asCalendarDate(filters.dateFrom);
  const to = asCalendarDate(filters.dateTo);
  if (!from || !to || from > to) return null;
  return { from, to };
}

export function filtersToQuery(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.datePreset) params.set('date', filters.datePreset);
  if (filters.datePreset === CUSTOM_PRESET) {
    if (filters.dateFrom) params.set('from', filters.dateFrom);
    if (filters.dateTo) params.set('to', filters.dateTo);
  }
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

  const datePreset = date && PRESET_VALUES.has(date) ? date : null;
  const isCustom = datePreset === CUSTOM_PRESET;

  return {
    datePreset,
    dateFrom: isCustom ? asCalendarDate(params.get('from')) : null,
    dateTo: isCustom ? asCalendarDate(params.get('to')) : null,
    category: category && category.length <= MAX_CATEGORY_LENGTH ? category : null,
    granularity: params.get('granularity') === 'weekly' ? 'weekly' : 'monthly',
  };
}
