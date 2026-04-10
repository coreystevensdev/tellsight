'use client';

import { useState, useRef, useEffect, useCallback, useId, type KeyboardEvent } from 'react';
import { Calendar, Tag, X, RotateCcw, ChevronDown } from 'lucide-react';
import { trackClientEvent } from '@/lib/analytics';
import { ANALYTICS_EVENTS } from 'shared/constants';

export interface FilterState {
  datePreset: string | null;
  category: string | null;
}

export const DATE_PRESETS = [
  { label: 'All time', value: 'all' },
  { label: 'Last month', value: 'last-month' },
  { label: 'Last 3 months', value: 'last-3-months' },
  { label: 'Last 6 months', value: 'last-6-months' },
  { label: 'Last year', value: 'last-year' },
] as const;

export type DatePresetValue = (typeof DATE_PRESETS)[number]['value'];

export function computeDateRange(preset: string): { from: string; to: string } | null {
  if (preset === 'all') return null;

  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  let from: Date;

  switch (preset) {
    case 'last-month':
      from = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
      break;
    case 'last-3-months':
      from = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
      break;
    case 'last-6-months':
      from = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
      break;
    case 'last-year':
      from = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
      break;
    default:
      return null;
  }

  return { from: from.toISOString().slice(0, 10), to };
}

// generic accessible dropdown — trigger + listbox with keyboard nav
function FilterDropdown({
  label,
  icon: Icon,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  icon: typeof Calendar;
  value: string | null;
  options: { label: string; value: string }[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? label;

  // close on outside click
  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // scroll focused option into view
  useEffect(() => {
    if (!open || focusIdx < 0) return;
    const items = listRef.current?.children;
    if (items?.[focusIdx]) {
      (items[focusIdx] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [open, focusIdx]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (disabled) return;

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!open) {
            setOpen(true);
            const idx = options.findIndex((o) => o.value === value);
            setFocusIdx(idx >= 0 ? idx : 0);
          } else if (focusIdx >= 0) {
            const opt = options[focusIdx];
            if (opt) {
              // "All time" / first option treated as "no filter"
              onChange(opt.value === options[0]?.value ? null : opt.value);
            }
            setOpen(false);
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (!open) {
            setOpen(true);
            setFocusIdx(0);
          } else {
            setFocusIdx((i) => Math.min(i + 1, options.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (open) {
            setFocusIdx((i) => Math.max(i - 1, 0));
          }
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
        case 'Home':
          if (open) {
            e.preventDefault();
            setFocusIdx(0);
          }
          break;
        case 'End':
          if (open) {
            e.preventDefault();
            setFocusIdx(options.length - 1);
          }
          break;
      }
    },
    [disabled, open, focusIdx, options, value, onChange],
  );

  const handleSelect = (opt: { label: string; value: string }, idx: number) => {
    setFocusIdx(idx);
    // first option = "all" / clear
    onChange(idx === 0 ? null : opt.value);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((prev) => {
            if (!prev) {
              const idx = options.findIndex((o) => o.value === value);
              setFocusIdx(idx >= 0 ? idx : 0);
            }
            return !prev;
          });
        }}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && focusIdx >= 0 ? `${uid}-opt-${focusIdx}` : undefined}
        aria-label={`Filter by ${label.toLowerCase()}`}
        disabled={disabled}
        className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
      >
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="max-w-[140px] truncate">{displayLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-1 max-h-60 min-w-[180px] overflow-auto rounded-md border border-border bg-card py-1 shadow-lg animate-fade-in"
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value || (value === null && idx === 0);
            const isFocused = idx === focusIdx;

            return (
              <li
                key={opt.value}
                id={`${uid}-opt-${idx}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(opt, idx)}
                onMouseEnter={() => setFocusIdx(idx)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  isFocused ? 'bg-accent text-accent-foreground' : 'text-card-foreground'
                } ${isSelected ? 'font-medium' : ''}`}
              >
                {opt.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterBadge({
  label,
  onDismiss,
}: {
  label: string;
  onDismiss: () => void;
}) {
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
    onFilterChange({ ...filters, datePreset: value });
  };

  const handleCategoryChange = (value: string | null) => {
    if (value) {
      trackClientEvent(ANALYTICS_EVENTS.CHART_FILTERED, { filterType: 'category', value });
    }
    onFilterChange({ ...filters, category: value });
  };

  const handleReset = () => {
    onFilterChange({ datePreset: null, category: null });
  };

  return (
    <div
      className="sticky top-14 z-30 -mx-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
      role="toolbar"
      aria-label="Chart filters"
    >
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown
          label="Date range"
          icon={Calendar}
          value={filters.datePreset}
          options={dateOptions}
          onChange={handleDateChange}
          disabled={disabled}
        />

        <FilterDropdown
          label="Category"
          icon={Tag}
          value={filters.category}
          options={categoryOptions}
          onChange={handleCategoryChange}
          disabled={disabled}
        />

        {hasActiveFilters && (
          <>
            <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />

            {filters.datePreset && selectedPresetLabel && (
              <FilterBadge
                label={selectedPresetLabel}
                onDismiss={() => handleDateChange(null)}
              />
            )}

            {filters.category && (
              <FilterBadge
                label={filters.category}
                onDismiss={() => handleCategoryChange(null)}
              />
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
