'use client';

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

interface FilterOption {
  label: string;
  value: string;
}

interface FilterDropdownProps {
  label: string;
  icon: LucideIcon;
  value: string | null;
  options: FilterOption[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

export function FilterDropdown({
  label,
  icon: Icon,
  value,
  options,
  onChange,
  disabled,
}: FilterDropdownProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedOption = options.find((option) => option.value === value);
  const displayLabel = selectedOption?.label ?? label;

  useEffect(() => {
    if (!open) return;

    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (!open || focusIndex < 0) return;
    const item = listRef.current?.children[focusIndex];
    if (item) (item as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [open, focusIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (disabled) return;

      switch (event.key) {
        case 'Enter':
        case ' ':
          event.preventDefault();
          if (!open) {
            setOpen(true);
            const index = options.findIndex((option) => option.value === value);
            setFocusIndex(index >= 0 ? index : 0);
          } else if (focusIndex >= 0) {
            const option = options[focusIndex];
            if (option) onChange(option.value === options[0]?.value ? null : option.value);
            setOpen(false);
          }
          break;
        case 'ArrowDown':
          event.preventDefault();
          if (!open) {
            setOpen(true);
            setFocusIndex(0);
          } else {
            setFocusIndex((index) => Math.min(index + 1, options.length - 1));
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          if (open) setFocusIndex((index) => Math.max(index - 1, 0));
          break;
        case 'Escape':
          event.preventDefault();
          setOpen(false);
          break;
        case 'Home':
          if (open) {
            event.preventDefault();
            setFocusIndex(0);
          }
          break;
        case 'End':
          if (open) {
            event.preventDefault();
            setFocusIndex(options.length - 1);
          }
          break;
      }
    },
    [disabled, open, focusIndex, options, value, onChange],
  );

  const handleSelect = (option: FilterOption, index: number) => {
    setFocusIndex(index);
    onChange(index === 0 ? null : option.value);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          setOpen((wasOpen) => {
            if (!wasOpen) {
              const index = options.findIndex((option) => option.value === value);
              setFocusIndex(index >= 0 ? index : 0);
            }
            return !wasOpen;
          });
        }}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-activedescendant={open && focusIndex >= 0 ? `${uid}-opt-${focusIndex}` : undefined}
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
          {options.map((option, index) => {
            const isSelected = option.value === value || (value === null && index === 0);
            const isFocused = index === focusIndex;

            return (
              <li
                key={option.value}
                id={`${uid}-opt-${index}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => handleSelect(option, index)}
                onMouseEnter={() => setFocusIndex(index)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  isFocused ? 'bg-accent text-accent-foreground' : 'text-card-foreground'
                } ${isSelected ? 'font-medium' : ''}`}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
