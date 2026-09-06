import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { KpiCards } from './KpiCards';

// This component renders under DashboardShell.test.tsx, which mocks RevenueChart
// and friends but not this one, so it executes under test and a coverage tool
// calls it covered while no assertion reaches it. Killing the year-over-year
// branch entirely, or raising the compact-formatting threshold to a billion,
// both left the whole web suite green.

function trend(...revenues: number[]) {
  return revenues.map((revenue, i) => ({
    month: `2026-${String((i % 12) + 1).padStart(2, '0')}`,
    revenue,
  }));
}

function expenses(...items: Array<[string, number]>) {
  return items.map(([category, total]) => ({ category, total, percentage: 0 }));
}

describe('KpiCards totals', () => {
  it('sums revenue and expenses and reports the difference', () => {
    render(<KpiCards revenueTrend={trend(1000, 2000)} expenseBreakdown={expenses(['Rent', 500])} />);

    expect(screen.getByText('$3.0K')).toBeInTheDocument();
    expect(screen.getByText('$500')).toBeInTheDocument();
    expect(screen.getByText('$2.5K')).toBeInTheDocument();
  });

  // Net Profit is the one card that routinely goes negative, and it used to be
  // formatted by a local copy of formatAbbreviated that compared the raw value
  // against its thresholds. Negatives fell through both, so a loss of 2.5m
  // rendered as "$-2500000" while a gain of the same size rendered "$2.5M".
  it('formats a loss compactly, with the sign outside the currency symbol', () => {
    render(<KpiCards revenueTrend={trend(100_000)} expenseBreakdown={expenses(['Payroll', 2_600_000])} />);

    expect(screen.getByText('-$2.5M')).toBeInTheDocument();
    expect(screen.queryByText(/\$-/)).not.toBeInTheDocument();
  });

  // The expected value stays out of the title: vitest reads $ in an it.each name
  // as a property accessor, so '-$999' printed as '-undefined'.
  it.each([
    [4_300, 8_600, '-$4.3K'],
    [500, 1_499, '-$999'],
  ])('formats a loss of %s against %s compactly', (revenue, expense, expected) => {
    render(<KpiCards revenueTrend={trend(revenue)} expenseBreakdown={expenses(['X', expense])} />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('renders nothing when there is no data at all', () => {
    const { container } = render(<KpiCards revenueTrend={[]} expenseBreakdown={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows N/A when no expense categories exist', () => {
    render(<KpiCards revenueTrend={trend(1000)} expenseBreakdown={[]} />);

    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('names the largest expense category', () => {
    render(
      <KpiCards revenueTrend={trend(1000)} expenseBreakdown={expenses(['Payroll', 900], ['Rent', 100])} />,
    );

    expect(screen.getByText('Payroll')).toBeInTheDocument();
  });
});

describe('KpiCards revenue trend', () => {
  // 13 points is the first length where the same month last year exists. With
  // fewer, the comparison falls back to the previous month, and the label has to
  // say which comparison the number actually is.
  it('compares against the same month last year once 13 points exist', () => {
    const points = trend(...Array.from({ length: 13 }, (_, i) => (i === 0 ? 1000 : 2000)));
    render(<KpiCards revenueTrend={points} expenseBreakdown={expenses(['X', 1])} />);

    expect(screen.getByText('vs last year')).toBeInTheDocument();
    // The sign and the number are separate text nodes inside one span, so a
    // plain string matcher cannot span them.
    expect(
      screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '+100%'),
    ).toBeInTheDocument();
  });

  it('falls back to the previous month with only 12 points', () => {
    const points = trend(...Array.from({ length: 12 }, (_, i) => (i === 10 ? 1000 : 2000)));
    render(<KpiCards revenueTrend={points} expenseBreakdown={expenses(['X', 1])} />);

    expect(screen.getByText('vs prev month')).toBeInTheDocument();
  });

  it('shows no trend at all from a single point', () => {
    render(<KpiCards revenueTrend={trend(1000)} expenseBreakdown={expenses(['X', 1])} />);

    expect(screen.queryByText(/vs (last year|prev month)/)).not.toBeInTheDocument();
  });

  // Dividing by a zero prior period would be Infinity, so the branch returns
  // null and the trend is simply absent rather than nonsense.
  it('shows no trend when the prior period was zero', () => {
    render(<KpiCards revenueTrend={trend(0, 5000)} expenseBreakdown={expenses(['X', 1])} />);

    expect(screen.queryByText(/vs prev month/)).not.toBeInTheDocument();
  });
});
