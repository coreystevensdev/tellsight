import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FilterBar, computeDateRange, type FilterState } from './FilterBar';

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const defaultProps = {
  filters: { datePreset: null, category: null, granularity: 'monthly' } as FilterState,
  onFilterChange: vi.fn(),
  availableCategories: ['Payroll', 'Rent', 'Marketing'],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FilterBar', () => {
  it('renders with toolbar role and aria-label', () => {
    render(<FilterBar {...defaultProps} />);

    expect(screen.getByRole('toolbar', { name: 'Chart filters' })).toBeInTheDocument();
  });

  it('renders date range and category dropdown triggers', () => {
    render(<FilterBar {...defaultProps} />);

    expect(screen.getByRole('button', { name: /filter by date range/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by category/i })).toBeInTheDocument();
  });

  it('shows default labels when no filters active', () => {
    render(<FilterBar {...defaultProps} />);

    expect(screen.getByText('Date range')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
  });

  it('does not show reset button when no filters active', () => {
    render(<FilterBar {...defaultProps} />);

    expect(screen.queryByRole('button', { name: /clear all filters/i })).not.toBeInTheDocument();
  });

  describe('date range dropdown', () => {
    it('opens listbox on click', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      fireEvent.click(trigger);

      expect(screen.getByRole('listbox', { name: 'Date range' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'All time' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Last month' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Last 3 months' })).toBeInTheDocument();
    });

    it('selects a date preset and calls onFilterChange', () => {
      render(<FilterBar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /filter by date range/i }));
      fireEvent.click(screen.getByRole('option', { name: 'Last 3 months' }));

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: 'last-3-months',
        category: null,
        granularity: 'monthly',
      });
    });

    it('clears date filter when "All time" is selected', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-3-months', category: null, granularity: 'monthly' }}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /filter by date range/i }));
      fireEvent.click(screen.getByRole('option', { name: 'All time' }));

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: null,
        category: null,
        granularity: 'monthly',
      });
    });

    it('closes dropdown on Escape key', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      fireEvent.click(trigger);
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  describe('category dropdown', () => {
    it('shows available categories as options', () => {
      render(<FilterBar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /filter by category/i }));

      expect(screen.getByRole('option', { name: 'All categories' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Payroll' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Rent' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Marketing' })).toBeInTheDocument();
    });

    it('selects a category and calls onFilterChange', () => {
      render(<FilterBar {...defaultProps} />);

      fireEvent.click(screen.getByRole('button', { name: /filter by category/i }));
      fireEvent.click(screen.getByRole('option', { name: 'Payroll' }));

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: null,
        category: 'Payroll',
        granularity: 'monthly',
      });
    });
  });

  describe('active filter badges', () => {
    it('shows date preset badge when active', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-3-months', category: null, granularity: 'monthly' }}
        />,
      );

      // badge has a dismiss button with descriptive aria-label
      expect(
        screen.getByRole('button', { name: /last 3 months filter active/i }),
      ).toBeInTheDocument();
    });

    it('shows category badge when active', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: null, category: 'Payroll', granularity: 'monthly' }}
        />,
      );

      // badge has a dismiss button with descriptive aria-label
      expect(
        screen.getByRole('button', { name: /payroll filter active/i }),
      ).toBeInTheDocument();
    });

    it('dismisses date badge on click', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-month', category: 'Rent', granularity: 'monthly' }}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: /last month filter active/i }),
      );

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: null,
        category: 'Rent',
        granularity: 'monthly',
      });
    });

    it('dismisses category badge on click', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-month', category: 'Rent', granularity: 'monthly' }}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', { name: /rent filter active/i }),
      );

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: 'last-month',
        category: null,
        granularity: 'monthly',
      });
    });
  });

  describe('reset button', () => {
    it('shows when filters are active', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-year', category: null, granularity: 'monthly' }}
        />,
      );

      expect(screen.getByRole('button', { name: /clear all filters/i })).toBeInTheDocument();
    });

    it('clears all filters on click', () => {
      render(
        <FilterBar
          {...defaultProps}
          filters={{ datePreset: 'last-year', category: 'Payroll', granularity: 'monthly' }}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /clear all filters/i }));

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: null,
        category: null,
        granularity: 'monthly',
      });
    });
  });

  describe('keyboard navigation', () => {
    it('opens dropdown with Enter key', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      fireEvent.keyDown(trigger, { key: 'Enter' });

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('opens dropdown with Space key', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      fireEvent.keyDown(trigger, { key: ' ' });

      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });

    it('navigates options with ArrowDown/ArrowUp', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });

      const listbox = screen.getByRole('listbox');
      expect(listbox).toBeInTheDocument();

      // ArrowDown again moves focus to next option
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });

      // ArrowUp moves back
      fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    });

    it('selects focused option with Enter', () => {
      render(<FilterBar {...defaultProps} />);

      const trigger = screen.getByRole('button', { name: /filter by date range/i });
      // open
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      // move to "Last month" (index 1)
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      // select
      fireEvent.keyDown(trigger, { key: 'Enter' });

      expect(defaultProps.onFilterChange).toHaveBeenCalledWith({
        datePreset: 'last-month',
        category: null,
        granularity: 'monthly',
      });
    });
  });

  describe('disabled state', () => {
    it('disables dropdowns when disabled prop is true', () => {
      render(<FilterBar {...defaultProps} disabled />);

      expect(screen.getByRole('button', { name: /filter by date range/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /filter by category/i })).toBeDisabled();
    });
  });

  describe('sticky positioning', () => {
    it('has sticky class and correct top offset', () => {
      render(<FilterBar {...defaultProps} />);

      const toolbar = screen.getByRole('toolbar');
      expect(toolbar.className).toContain('sticky');
      expect(toolbar.className).toContain('top-0');
    });
  });
});

describe('computeDateRange', () => {
  it('returns null for "all" preset', () => {
    expect(computeDateRange('all')).toBeNull();
  });

  it('returns valid date range for "last-month"', () => {
    const result = computeDateRange('last-month');
    expect(result).not.toBeNull();
    expect(result!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result!.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // rolling window through today, consistent with other presets
    // Built from local parts, like computeDateRange does. toISOString() converts
    // to UTC first, which is the shift this preset was fixed to avoid, so using
    // it here compared a local answer against a UTC expectation.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(result!.to).toBe(today);
    expect(new Date(result!.from).getTime()).toBeLessThan(new Date(result!.to).getTime());
  });

  it('returns valid date range for "last-3-months"', () => {
    const result = computeDateRange('last-3-months');
    expect(result).not.toBeNull();
    const from = new Date(result!.from);
    const to = new Date(result!.to);
    const diffMonths = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    expect(diffMonths).toBe(3);
  });

  it('returns valid date range for "last-6-months"', () => {
    const result = computeDateRange('last-6-months');
    expect(result).not.toBeNull();
    const from = new Date(result!.from);
    const to = new Date(result!.to);
    const diffMonths = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    expect(diffMonths).toBe(6);
  });

  it('returns valid date range for "last-year"', () => {
    const result = computeDateRange('last-year');
    expect(result).not.toBeNull();
    const from = new Date(result!.from);
    const to = new Date(result!.to);
    const diffMonths = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    expect(diffMonths).toBe(12);
  });

  it('returns null for unknown preset', () => {
    expect(computeDateRange('unknown')).toBeNull();
  });

  // The tests above run against whatever today happens to be, so the month-end
  // overflow bug only surfaced on some dates. These pin the dates that broke.
  describe('month-end day clamping', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Local midday, not 12:00Z. computeDateRange reads local calendar parts, and
    // at UTC+13/+14 noon UTC is already the next day, which rolled every fixture
    // below forward by one and broke the clamping cases.
    const on = (year: number, month: number, day: number) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(year, month - 1, day, 12));
    };

    const spanInMonths = (r: { from: string; to: string }) => {
      const from = new Date(r.from);
      const to = new Date(r.to);
      return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    };

    it('lands on Feb 28 for last-6-months from Aug 30, not Mar 2', () => {
      on(2026, 8, 30);
      const result = computeDateRange('last-6-months')!;
      expect(result.from).toBe('2026-02-28');
      expect(spanInMonths(result)).toBe(6);
    });

    it('lands on Feb 28 for last-month from Mar 31, not Mar 3', () => {
      on(2026, 3, 31);
      const result = computeDateRange('last-month')!;
      expect(result.from).toBe('2026-02-28');
      expect(spanInMonths(result)).toBe(1);
    });

    it('keeps a full month when the target month is shorter, Jul 31 to Jun 30', () => {
      on(2026, 7, 31);
      const result = computeDateRange('last-month')!;
      expect(result.from).toBe('2026-06-30');
      expect(spanInMonths(result)).toBe(1);
    });

    // Sydney is UTC+10, so a morning there is still "yesterday" in UTC. These
    // pin the case where the two calendars disagree, which is exactly when
    // formatting through toISOString() used to hand back the wrong day.
    describe('east of UTC', () => {
      const realTz = process.env.TZ;

      afterEach(() => {
        // Assigning undefined here would store the string "undefined", which
        // leaves Intl unable to resolve a zone at all. TZ is normally unset.
        if (realTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = realTz;
        }
        vi.useRealTimers();
      });

      function sydneyMorningOf(iso: string) {
        process.env.TZ = 'Australia/Sydney';
        vi.useFakeTimers();
        vi.setSystemTime(new Date(iso));
      }

      it('uses the local calendar date, not the UTC one, for the range end', () => {
        // 2026-08-29T20:00Z is 2026-08-30 06:00 in Sydney.
        sydneyMorningOf('2026-08-29T20:00:00Z');

        const result = computeDateRange('last-month')!;
        expect(result.to).toBe('2026-08-30');
        expect(result.from).toBe('2026-07-30');
      });

      it('does not lose the current day on the six-month preset', () => {
        sydneyMorningOf('2026-08-29T20:00:00Z');

        const result = computeDateRange('last-6-months')!;
        expect(result.to).toBe('2026-08-30');
        expect(result.from).toBe('2026-02-28');
        expect(spanInMonths(result)).toBe(6);
      });
    });

    it('handles a leap year, last-year from Feb 29 2028', () => {
      on(2028, 2, 29);
      const result = computeDateRange('last-year')!;
      expect(result.from).toBe('2027-02-28');
      expect(spanInMonths(result)).toBe(12);
    });
  });
});
