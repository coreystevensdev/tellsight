import type { ReactElement } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const mockUseReducedMotion = vi.fn(() => false);

vi.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => mockUseReducedMotion(),
}));

let capturedBars: Array<Record<string, unknown>> = [];
let capturedScatter: Record<string, unknown> | null = null;

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive-container">{children}</div>,
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div data-testid="composed-chart">{children}</div>,
  Bar: (props: Record<string, unknown>) => {
    capturedBars.push(props);
    return null;
  },
  Scatter: (props: Record<string, unknown>) => {
    capturedScatter = props;
    return null;
  },
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

import { CategoryVarianceChart, PlannedMarker, VarianceTooltip, colorForDirection } from './CategoryVarianceChart';

afterEach(() => {
  cleanup();
  capturedBars = [];
  capturedScatter = null;
  mockUseReducedMotion.mockReturnValue(false);
});

const sampleData = [
  {
    category: 'Rent',
    plannedMonthly: 1000,
    actualMonthly: 1200,
    variance: 200,
    variancePercent: 20,
    monthLabel: 'Oct 2026',
    direction: 'over' as const,
  },
  {
    category: 'Marketing',
    plannedMonthly: 800,
    actualMonthly: 500,
    variance: -300,
    variancePercent: -37.5,
    monthLabel: 'Oct 2026',
    direction: 'under' as const,
  },
  {
    category: 'Software',
    plannedMonthly: 200,
    actualMonthly: 0,
    variance: -200,
    variancePercent: -100,
    monthLabel: 'Oct 2026',
    direction: 'under' as const,
  },
];

describe('colorForDirection', () => {
  it('maps over to destructive, under to success, and on_plan to a neutral tone', () => {
    expect(colorForDirection('over')).toBe('var(--color-destructive)');
    expect(colorForDirection('under')).toBe('var(--color-success)');
    expect(colorForDirection('on_plan')).toBe('var(--color-muted-foreground)');
  });
});

describe('CategoryVarianceChart', () => {
  it('renders as a figure with "Budget vs Actual" title', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    expect(screen.getByRole('figure')).toBeInTheDocument();
    expect(screen.getByText('Budget vs Actual')).toBeInTheDocument();
  });

  it('has role="img" with an aria-label naming the resolved month', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    const chartArea = screen.getByRole('img');
    expect(chartArea.getAttribute('aria-label')).toContain('Oct 2026');
  });

  it('shows the spent-of-planned summary with category count and month', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    // 1200 + 500 + 0 actual, 1000 + 800 + 200 planned
    expect(screen.getByText('$1,700 spent of $2,000 planned across 3 categories, Oct 2026')).toBeInTheDocument();
  });

  it('colors each bar by direction, not by the sign of variance', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    const bar = capturedBars.find((b) => b.dataKey === 'actualMonthly')!;
    const fills = (bar.children as ReactElement<{ fill?: string }>[]).map((c) => c.props.fill);

    expect(fills).toEqual([
      'var(--color-destructive)', // Rent, over
      'var(--color-success)', // Marketing, under
      'var(--color-success)', // Software, under: zero spend against a real plan is still "under", not neutral
    ]);
  });

  it('plots the planned-value marker as its own series keyed to plannedMonthly', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    expect(capturedScatter?.dataKey).toBe('plannedMonthly');
  });

  it('singularizes "category" for exactly one row', () => {
    render(<CategoryVarianceChart data={[sampleData[0]!]} />);

    expect(screen.getByText(/across 1 category,/)).toBeInTheDocument();
  });

  it('returns null when there are no planned categories', () => {
    const { container } = render(<CategoryVarianceChart data={[]} />);

    expect(container.innerHTML).toBe('');
  });

  it('enables animation when reduced motion is off', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    const bar = capturedBars.find((b) => b.dataKey === 'actualMonthly')!;
    expect(bar.isAnimationActive).toBe(true);
    expect(capturedScatter?.isAnimationActive).toBe(true);
  });

  it('disables animation when prefers-reduced-motion is active', () => {
    mockUseReducedMotion.mockReturnValue(true);
    render(<CategoryVarianceChart data={sampleData} />);

    const bar = capturedBars.find((b) => b.dataKey === 'actualMonthly')!;
    expect(bar.isAnimationActive).toBe(false);
    expect(capturedScatter?.isAnimationActive).toBe(false);
  });
});

describe('PlannedMarker', () => {
  // Wrapped in a real <svg>: rect is only a valid tag in the SVG namespace,
  // and rendering it bare logs a jsdom "unrecognized tag" warning that has
  // nothing to do with what this test checks.
  it('renders a rect centered on the given point', () => {
    const { container } = render(<svg><PlannedMarker cx={100} cy={50} /></svg>);
    const rect = container.querySelector('rect')!;

    const x = Number(rect.getAttribute('x'));
    const y = Number(rect.getAttribute('y'));
    const width = Number(rect.getAttribute('width'));
    const height = Number(rect.getAttribute('height'));

    expect(x + width / 2).toBe(100);
    expect(y + height / 2).toBe(50);
  });

  it('returns null when recharts has not resolved a position yet', () => {
    const { container } = render(<svg><PlannedMarker /></svg>);

    expect(container.querySelector('rect')).toBeNull();
  });
});

describe('VarianceTooltip', () => {
  const item = sampleData[0]!;

  it('shows the category, actual-of-planned, and signed variance', () => {
    render(<VarianceTooltip active payload={[{ dataKey: 'actualMonthly', payload: item }]} />);

    expect(screen.getByText('Rent')).toBeInTheDocument();
    expect(screen.getByText('$1,200 of $1,000 planned')).toBeInTheDocument();
    expect(screen.getByText('+$200 vs plan')).toBeInTheDocument();
  });

  it('signs a negative variance with a minus rather than a double sign', () => {
    render(<VarianceTooltip active payload={[{ dataKey: 'actualMonthly', payload: sampleData[1] }]} />);

    expect(screen.getByText('-$300 vs plan')).toBeInTheDocument();
  });

  it('returns null when not active', () => {
    const { container } = render(<VarianceTooltip active={false} payload={[{ dataKey: 'actualMonthly', payload: item }]} />);

    expect(container.innerHTML).toBe('');
  });

  it('returns null when no entry carries the row payload', () => {
    const { container } = render(<VarianceTooltip active payload={[{ dataKey: 'plannedMonthly' }]} />);

    expect(container.innerHTML).toBe('');
  });

  it('has role="status" with aria-live="polite"', () => {
    render(<VarianceTooltip active payload={[{ dataKey: 'actualMonthly', payload: item }]} />);

    const tooltip = screen.getByRole('status');
    expect(tooltip).toHaveAttribute('aria-live', 'polite');
  });
});
