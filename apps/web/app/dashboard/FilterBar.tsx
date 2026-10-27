'use client';

import { Calendar, Tag, X, RotateCcw } from 'lucide-react';
import { trackClientEvent } from '@/lib/analytics';
import { ANALYTICS_EVENTS } from 'shared/constants';
import type { Granularity } from 'shared/types';
import { CUSTOM_PRESET, DATE_PRESETS, EMPTY_FILTERS, type FilterState } from './filterParams';
import { FilterDropdown } from './FilterDropdown';

export { computeDateRange } from './dateRange';

function FilterBadge({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary animate-badge-in motion-reduce:animate-none">
      {label}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`${label} filter active, press to remove`}
        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (filters: FilterState) => void;
  availableCategories: string[];
  disabled?: boolean;
}

export function FilterBar({
  filters,
  onFilterChange,
  availableCategories,
  disabled,
}: FilterBarProps) {
  const hasActiveFilters = filters.datePreset !== null || filters.category !== null;

  const dateOptions = DATE_PRESETS.map((p) => ({ label: p.label, value: p.value }));
  const categoryOptions = [
    { label: 'All categories', value: 'all' },
    ...availableCategories.map((c) => ({ label: c, value: c })),
  ];

  const selectedPresetLabel = DATE_PRESETS.find((p) => p.value === filters.datePreset)?.label;

  const handleDateChange = (value: string | null) => {
    if (value) {
      trackClientEvent(ANALYTICS_EVENTS.CHART_FILTERED, { filterType: 'date_range', value });
    }
    // Leaving custom drops the endpoints with it, so switching to a preset and
    // back does not silently restore dates that are no longer on screen.
    onFilterChange(
      value === CUSTOM_PRESET
        ? { ...filters, datePreset: value }
        : { ...filters, datePreset: value, dateFrom: null, dateTo: null },
    );
  };

  const setBound = (key: 'dateFrom' | 'dateTo') => (event: { target: { value: string } }) => {
    onFilterChange({ ...filters, [key]: event.target.value || null });
  };

  const handleCategoryChange = (value: string | null) => {
    if (value) {
      trackClientEvent(ANALYTICS_EVENTS.CHART_FILTERED, { filterType: 'category', value });
    }
    onFilterChange({ ...filters, category: value });
  };

  const handleGranularityChange = (value: Granularity) => {
    trackClientEvent(ANALYTICS_EVENTS.CHART_FILTERED, { filterType: 'granularity', value });
    onFilterChange({ ...filters, granularity: value });
  };

  const handleReset = () => {
    onFilterChange(EMPTY_FILTERS);
  };

  return (
    <div
      className="sticky top-0 z-30 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60 md:px-6 lg:px-8"
      role="toolbar"
      aria-label="Chart filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="inline-flex rounded-md border border-border"
          role="radiogroup"
          aria-label="Time granularity"
        >
          {(['weekly', 'monthly'] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={filters.granularity === g}
              onClick={() => handleGranularityChange(g)}
              disabled={disabled}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors first:rounded-l-md last:rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${
                filters.granularity === g
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              {g}
            </button>
          ))}
        </div>

        <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

        {/* Grouped so the pair wraps together on narrow screens, Date range
            and Category, never Category alone onto its own line. */}
        <div className="flex flex-nowrap items-center gap-2">
          <FilterDropdown
            label="Date range"
            icon={Calendar}
            value={filters.datePreset}
            options={dateOptions}
            onChange={handleDateChange}
            disabled={disabled}
          />

          {filters.datePreset === CUSTOM_PRESET && (
            <div className="flex flex-nowrap items-center gap-1.5">
              {/* Native date inputs rather than a calendar component: the
                  presets were chosen partly to avoid building one, and on a
                  phone this hands the job to the OS picker. min/max cross-bind
                  the pair so the browser refuses a backwards range before
                  customRange has to. */}
              <input
                type="date"
                aria-label="Range start"
                value={filters.dateFrom ?? ''}
                max={filters.dateTo ?? undefined}
                onChange={setBound('dateFrom')}
                disabled={disabled}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                aria-label="Range end"
                value={filters.dateTo ?? ''}
                min={filters.dateFrom ?? undefined}
                onChange={setBound('dateTo')}
                disabled={disabled}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
            </div>
          )}

          <FilterDropdown
            label="Category"
            icon={Tag}
            value={filters.category}
            options={categoryOptions}
            onChange={handleCategoryChange}
            disabled={disabled}
          />
        </div>

        {hasActiveFilters && (
          <>
            <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

            {filters.datePreset && selectedPresetLabel && (
              <FilterBadge label={selectedPresetLabel} onDismiss={() => handleDateChange(null)} />
            )}

            {filters.category && (
              <FilterBadge label={filters.category} onDismiss={() => handleCategoryChange(null)} />
            )}

            <button
              type="button"
              onClick={handleReset}
              aria-label="Clear all filters"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Reset filters
            </button>
          </>
        )}
      </div>
    </div>
  );
}
