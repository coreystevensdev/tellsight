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

import {
  CategoryVarianceChart,
  PlannedMarker,
  VarianceTooltip,
  colorForDirection,
  foldOverflowIntoOther,
} from './CategoryVarianceChart';

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

function item(category: string, plannedMonthly: number, actualMonthly: number) {
  const variance = Math.round((actualMonthly - plannedMonthly) * 100) / 100;
  const variancePercent = plannedMonthly === 0 ? 0 : Math.round((variance / plannedMonthly) * 1000) / 10;
  const direction = Math.abs(variancePercent) < 5 ? 'on_plan' as const : variance > 0 ? 'over' as const : 'under' as const;
  return { category, plannedMonthly, actualMonthly, variance, variancePercent, monthLabel: 'Oct 2026', direction };
}

describe('foldOverflowIntoOther', () => {
  it('passes six or fewer categories through unchanged', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'].map((c) => item(c, 1000, 1000));

    expect(foldOverflowIntoOther(six)).toEqual(six);
  });

  it('folds overflow past six into a synthesized Other, summing and recomputing direction', () => {
    const eight = [
      ...['A', 'B', 'C', 'D', 'E', 'F'].map((c) => item(c, 1000, 1000)),
      item('G', 500, 700), // over by 200
      item('H', 300, 350), // over by 50
    ];

    const result = foldOverflowIntoOther(eight);

    expect(result).toHaveLength(7);
    expect(result[6]).toMatchObject({
      category: 'Other',
      plannedMonthly: 800,
      actualMonthly: 1050,
      variance: 250,
      direction: 'over',
    });
  });

  it('merges overflow into a real Other category instead of adding a second entry', () => {
    const data = [
      ...['A', 'B', 'C', 'D', 'E'].map((c) => item(c, 1000, 1000)),
      item('Other', 100, 150), // over by 50 on its own
      item('F', 200, 180), // under by 20
      item('G', 50, 70), // over by 20
    ];

    const result = foldOverflowIntoOther(data);

    expect(result).toHaveLength(6);
    const others = result.filter((r) => r.category === 'Other');
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ plannedMonthly: 350, actualMonthly: 400, variance: 50, direction: 'over' });
  });

  it('matches an existing Other category case-insensitively and keeps its original casing', () => {
    const data = [
      ...['A', 'B', 'C', 'D', 'E'].map((c) => item(c, 1000, 1000)),
      item('OTHER', 100, 100),
      item('F', 200, 180),
    ];

    const result = foldOverflowIntoOther(data);

    const matches = result.filter((r) => r.category.toLowerCase() === 'other');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.category).toBe('OTHER');
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

  // recharts calls a function shape as shape(props, index), not as a
  // component, so the bare function reference works and stays stable across
  // renders instead of a new closure identity every time.
  it('passes PlannedMarker to Scatter by reference, not a wrapping closure', () => {
    render(<CategoryVarianceChart data={sampleData} />);

    expect(capturedScatter?.shape).toBe(PlannedMarker);
  });

  it('singularizes "category" for exactly one row', () => {
    render(<CategoryVarianceChart data={[sampleData[0]!]} />);

    expect(screen.getByText(/across 1 category,/)).toBeInTheDocument();
  });

  it('caps the rendered bars at seven (six named plus Other) while the summary still counts every plan', () => {
    const eight = [
      ...['A', 'B', 'C', 'D', 'E', 'F'].map((c) => item(c, 1000, 1000)),
      item('G', 500, 700),
      item('H', 300, 350),
    ];
    render(<CategoryVarianceChart data={eight} />);

    const bar = capturedBars.find((b) => b.dataKey === 'actualMonthly')!;
    expect((bar.children as unknown[]).length).toBe(7);
    expect(screen.getByText(/across 8 categories,/)).toBeInTheDocument();
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
