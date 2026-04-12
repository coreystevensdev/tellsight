import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockUseReducedMotion = vi.fn(() => false);

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

let capturedBarProps: Record<string, unknown> = {};

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  Bar: (props: Record<string, unknown>) => {
    capturedBarProps = props;
    return null;
  },
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

import { ExpenseChart, ExpenseTooltip } from './ExpenseChart';

const sampleData = [
  { category: 'Payroll', total: 8000 },
  { category: 'Rent', total: 3000 },
  { category: 'Marketing', total: 2000 },
];

afterEach(() => {
  cleanup();
  capturedBarProps = {};
  mockUseReducedMotion.mockReturnValue(false);
});

describe('ExpenseChart', () => {
  it('renders as a figure with "Expense Breakdown" title', () => {
    render(<ExpenseChart data={sampleData} />);

    expect(screen.getByRole('figure')).toBeInTheDocument();
    expect(screen.getByText('Expense Breakdown')).toBeInTheDocument();
  });

  it('has role="img" with aria-label mentioning highest category', () => {
    render(<ExpenseChart data={sampleData} />);

    const chartArea = screen.getByRole('img');
    const label = chartArea.getAttribute('aria-label')!;
    expect(label).toContain('Bar chart');
    expect(label).toContain('Payroll');
    expect(label).toContain('$8,000');
  });

  it('shows total expenses callout with category count', () => {
    render(<ExpenseChart data={sampleData} />);

    expect(screen.getByText('$13,000 total across 3 categories')).toBeInTheDocument();
  });

  it('shows "$0 total" when all totals are zero', () => {
    const emptyData = [
      { category: 'Payroll', total: 0 },
      { category: 'Rent', total: 0 },
    ];
    render(<ExpenseChart data={emptyData} />);

    expect(screen.getByText('$0 total')).toBeInTheDocument();
  });

  it('enables animation when reduced motion is off', () => {
    mockUseReducedMotion.mockReturnValue(false);
    render(<ExpenseChart data={sampleData} />);

    expect(capturedBarProps.isAnimationActive).toBe(true);
  });

  it('disables animation when prefers-reduced-motion is active', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(<ExpenseChart data={sampleData} />);

    expect(capturedBarProps.isAnimationActive).toBe(false);
  });
});

describe('ExpenseTooltip', () => {
  it('shows formatted currency when active with payload', () => {
    render(<ExpenseTooltip active payload={[{ value: 8000 }]} label="Payroll" />);

    expect(screen.getByText('Payroll')).toBeInTheDocument();
    expect(screen.getByText('$8,000')).toBeInTheDocument();
  });

  it('shows "No data" message for null payload value', () => {
    render(<ExpenseTooltip active payload={[{ value: null }]} label="Rent" />);

    expect(screen.getByText('No data for this category')).toBeInTheDocument();
  });

  it('returns null when not active', () => {
    const { container } = render(<ExpenseTooltip active={false} payload={[{ value: 100 }]} label="Rent" />);

    expect(container.innerHTML).toBe('');
  });

  it('has role="status" with aria-live="polite"', () => {
    render(<ExpenseTooltip active payload={[{ value: 3000 }]} label="Rent" />);

    const tooltip = screen.getByRole('status');
    expect(tooltip).toHaveAttribute('aria-live', 'polite');
  });
});
