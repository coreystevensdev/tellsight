import type { ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockUseReducedMotion = vi.fn(() => false);

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

let capturedBars: Array<Record<string, unknown>> = [];

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  Bar: (props: Record<string, unknown>) => {
    capturedBars.push(props);
    return null;
  },
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ReferenceLine: () => null,
}));

import { ProfitBridgeChart, BridgeTooltip, buildBridge, colorForDelta } from './ProfitBridgeChart';

afterEach(() => {
  cleanup();
  capturedBars = [];
  mockUseReducedMotion.mockReturnValue(false);
});

// Revenue 22,000; expenses 13,000 across three named categories; profit
// 9,000 on both sides (4,000 + 5,000 from monthlyComparison, 22,000 - 13,000
// from the breakdown), so this fixture closes by construction.
const monthlyComparison = [
  { month: 'Jan 2026', revenue: 10000, expenses: 6000, profit: 4000 },
  { month: 'Feb 2026', revenue: 12000, expenses: 7000, profit: 5000 },
];
const expenseBreakdown = [
  { category: 'Payroll', total: 8000 },
  { category: 'Rent', total: 3000 },
  { category: 'Marketing', total: 2000 },
];

describe('buildBridge', () => {
  it('closes: the final cumulative step lands on monthlyComparison profit summed over the same window', () => {
    const result = buildBridge(monthlyComparison, expenseBreakdown);

    expect(result.reportedProfit).toBe(9000);
    expect(result.bridgeProfit).toBe(9000);
    expect(result.closes).toBe(true);
  });

  it('flags a drift instead of silently landing somewhere else', () => {
    // expenseBreakdown here describes a different total than the expenses
    // monthlyComparison already reports, the exact bucketing-drift failure
    // the design calls out.
    const driftedBreakdown = [{ category: 'Rent', total: 999999 }];

    const result = buildBridge(monthlyComparison, driftedBreakdown);

    expect(result.closes).toBe(false);
  });

  it('builds a two-bar bridge when there are no expense categories, profit equal to revenue', () => {
    const result = buildBridge(
      [{ month: 'Jan 2026', revenue: 4000, expenses: 0, profit: 4000 }],
      [],
    );

    expect(result.steps.map((s) => s.label)).toEqual(['Revenue', 'Profit']);
    expect(result.bridgeProfit).toBe(result.totalRevenue);
    expect(result.closes).toBe(true);
  });

  it('builds a three-bar bridge for a single category', () => {
    const result = buildBridge(
      [{ month: 'Jan 2026', revenue: 4000, expenses: 1000, profit: 3000 }],
      [{ category: 'Rent', total: 1000 }],
    );

    expect(result.steps.map((s) => s.label)).toEqual(['Revenue', 'Rent', 'Profit']);
  });

  it('folds anything past the sixth category into one Other step', () => {
    const eightCategories = [
      { category: 'Payroll', total: 6000 },
      { category: 'Rent', total: 3000 },
      { category: 'Marketing', total: 2000 },
      { category: 'Software', total: 1500 },
      { category: 'Insurance', total: 1200 },
      { category: 'Utilities', total: 800 },
      { category: 'Travel', total: 400 },
      { category: 'Office Supplies', total: 100 },
    ];
    const result = buildBridge(
      [{ month: 'Jan 2026', revenue: 20000, expenses: 15000, profit: 5000 }],
      eightCategories,
    );

    expect(result.steps.map((s) => s.label)).toEqual([
      'Revenue', 'Payroll', 'Rent', 'Marketing', 'Software', 'Insurance', 'Utilities', 'Other', 'Profit',
    ]);
    expect(result.steps.find((s) => s.label === 'Other')?.delta).toBe(-500);
    expect(result.closes).toBe(true);
  });

  it('sorts categories itself, so Other still folds in the smallest ones when the caller does not sort', () => {
    const unsorted = [
      { category: 'Travel', total: 400 },
      { category: 'Payroll', total: 6000 },
      { category: 'Office Supplies', total: 100 },
      { category: 'Rent', total: 3000 },
      { category: 'Marketing', total: 2000 },
      { category: 'Software', total: 1500 },
      { category: 'Insurance', total: 1200 },
      { category: 'Utilities', total: 800 },
    ];
    const result = buildBridge(
      [{ month: 'Jan 2026', revenue: 20000, expenses: 15000, profit: 5000 }],
      unsorted,
    );

    expect(result.steps.map((s) => s.label)).toEqual([
      'Revenue', 'Payroll', 'Rent', 'Marketing', 'Software', 'Insurance', 'Utilities', 'Other', 'Profit',
    ]);
    expect(result.steps.find((s) => s.label === 'Other')?.delta).toBe(-500);
  });

  it('closes on a loss, landing the final bar below zero', () => {
    const result = buildBridge(
      [{ month: 'Jan 2026', revenue: 5000, expenses: 8000, profit: -3000 }],
      [
        { category: 'Payroll', total: 5000 },
        { category: 'Rent', total: 3000 },
      ],
    );

    expect(result.bridgeProfit).toBe(-3000);
    expect(result.closes).toBe(true);
    expect(result.steps.at(-1)?.delta).toBeLessThan(0);
  });
});

describe('colorForDelta', () => {
  it('is success for a non-negative step and destructive for a negative one', () => {
    expect(colorForDelta(100)).toBe('var(--color-success)');
    expect(colorForDelta(0)).toBe('var(--color-success)');
    expect(colorForDelta(-100)).toBe('var(--color-destructive)');
  });
});

describe('ProfitBridgeChart', () => {
  it('renders as a figure with "Revenue to Profit" title', () => {
    render(<ProfitBridgeChart monthlyComparison={monthlyComparison} expenseBreakdown={expenseBreakdown} />);

    expect(screen.getByRole('figure')).toBeInTheDocument();
    expect(screen.getByText('Revenue to Profit')).toBeInTheDocument();
  });

  it('has role="img" with an aria-label naming revenue and profit', () => {
    render(<ProfitBridgeChart monthlyComparison={monthlyComparison} expenseBreakdown={expenseBreakdown} />);

    const chartArea = screen.getByRole('img');
    const label = chartArea.getAttribute('aria-label')!;
    expect(label).toContain('$22,000');
    expect(label).toContain('$9,000');
  });

  it('shows the profit-from-revenue summary with the category count', () => {
    render(<ProfitBridgeChart monthlyComparison={monthlyComparison} expenseBreakdown={expenseBreakdown} />);

    expect(screen.getByText(/revenue across 3 expense categories/)).toBeInTheDocument();
  });

  it('drops the category clause when there are no expenses', () => {
    render(
      <ProfitBridgeChart
        monthlyComparison={[{ month: 'Jan 2026', revenue: 4000, expenses: 0, profit: 4000 }]}
        expenseBreakdown={[]}
      />,
    );

    expect(screen.getByText('profit from $4,000 revenue')).toBeInTheDocument();
  });

  it('colors the Revenue bar success and the final bar destructive on a loss', () => {
    render(
      <ProfitBridgeChart
        monthlyComparison={[{ month: 'Jan 2026', revenue: 5000, expenses: 8000, profit: -3000 }]}
        expenseBreakdown={[{ category: 'Rent', total: 8000 }]}
      />,
    );

    const valueBar = capturedBars.find((b) => b.dataKey === 'value')!;
    const fills = (valueBar.children as ReactElement<{ fill?: string }>[]).map((c) => c.props.fill);
    expect(fills[0]).toBe('var(--color-success)');
    expect(fills.at(-1)).toBe('var(--color-destructive)');
  });

  it('renders a reconciliation notice instead of a chart when the bridge does not close', () => {
    render(
      <ProfitBridgeChart
        monthlyComparison={monthlyComparison}
        expenseBreakdown={[{ category: 'Rent', total: 999999 }]}
      />,
    );

    expect(screen.getByText(/do not add up for this range/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('returns null when there is no monthly comparison data', () => {
    const { container } = render(<ProfitBridgeChart monthlyComparison={[]} expenseBreakdown={expenseBreakdown} />);

    expect(container.innerHTML).toBe('');
  });

  it('enables animation when reduced motion is off', () => {
    render(<ProfitBridgeChart monthlyComparison={monthlyComparison} expenseBreakdown={expenseBreakdown} />);

    const valueBar = capturedBars.find((b) => b.dataKey === 'value')!;
    expect(valueBar.isAnimationActive).toBe(true);
  });

  it('disables animation when prefers-reduced-motion is active', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(<ProfitBridgeChart monthlyComparison={monthlyComparison} expenseBreakdown={expenseBreakdown} />);

    const valueBar = capturedBars.find((b) => b.dataKey === 'value')!;
    expect(valueBar.isAnimationActive).toBe(false);
  });
});

describe('BridgeTooltip', () => {
  const step = { label: 'Rent', base: 9000, value: 3000, delta: -3000 };

  it('shows the step label and signed currency from the value entry', () => {
    render(<BridgeTooltip active payload={[{ dataKey: 'base', payload: step }, { dataKey: 'value', payload: step }]} />);

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('-$3,000')).toBeInTheDocument();
  });

  it('prefixes a positive step with a plus sign', () => {
    const upStep = { label: 'Revenue', base: 0, value: 22000, delta: 22000 };
    render(<BridgeTooltip active payload={[{ dataKey: 'value', payload: upStep }]} />);

    expect(screen.getByText('+$22,000')).toBeInTheDocument();
  });

  it('returns null when not active', () => {
    const { container } = render(<BridgeTooltip active={false} payload={[{ dataKey: 'value', payload: step }]} />);

    expect(container.innerHTML).toBe('');
  });

  it('returns null when the value entry is missing', () => {
    const { container } = render(<BridgeTooltip active payload={[{ dataKey: 'base', payload: step }]} />);

    expect(container.innerHTML).toBe('');
  });

  it('has role="status" with aria-live="polite"', () => {
    render(<BridgeTooltip active payload={[{ dataKey: 'value', payload: step }]} />);

    const tooltip = screen.getByRole('status');
    expect(tooltip).toHaveAttribute('aria-live', 'polite');
  });
});
